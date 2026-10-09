import { afterEach, describe, expect, it } from 'vitest';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  playScriptedGame,
  rejoinRoom,
  sleep,
  startRoom,
  startServer,
  stopServer,
  sweepAllPayloads,
  waitFor,
  type Connected,
  type Rig,
} from './helpers';

const rigs: Rig[] = [];

async function freshRig(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

interface Seated {
  rig: Rig;
  clients: Connected[];
  roomCode: string;
  tokens: string[];
}

async function startFullRoom(): Promise<Seated> {
  const rig = await freshRig();
  const creator = await connect(rig);
  const created = await createRoom(creator.client);
  const joiners = await connectAll(rig, 11);
  const tokens: string[] = [created.sessionToken];
  for (const j of joiners) {
    const ack = await joinRoom(j.client, created.roomCode);
    if ('spectator' in ack) throw new Error('unexpected spectator join');
    tokens.push(ack.sessionToken);
  }
  await startRoom(creator.client);
  return { rig, clients: [creator, ...joiners], roomCode: created.roomCode, tokens };
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

describe('reconnect over real sockets', () => {
  it('reattaches mid-game with the seat, a fresh view, and the full event backlog', async () => {
    const { rig, clients, roomCode, tokens } = await startFullRoom();

    // Let defaults carry night 1 and day 1 forward, then drop a player.
    await waitFor(() => rig.recs.some((r) => (r.latest?.dayNumber ?? 0) >= 2), 20_000);
    const victim = clients[5];
    const victimSeat = victim.rec.latest?.you.seat;
    expect(victimSeat).toBeDefined();
    const logLengthBefore = victim.rec.latest?.log.length ?? 0;
    expect(logLengthBefore).toBeGreaterThan(0);
    victim.client.disconnect();

    // The game keeps moving on injected defaults while the seat is gone.
    await sleep(300);

    const revived = await connect(rig);
    const ack = await rejoinRoom(revived.client, roomCode, tokens[5]);
    expect(ack.seat).toBe(victimSeat);
    const view = revived.rec.latest;
    expect(view?.you.seat).toBe(victimSeat);
    expect(view?.log[0]?.type).toBe('GAME_STARTED');
    expect(view?.log.length).toBeGreaterThan(0);
    // The backlog is the shared history, not just the newest phase.
    expect(view?.log.length).toBeGreaterThan(logLengthBefore - 1);
    expect(view?.phase).not.toBe('lobby');
    // Backlog stays clean: no server-only events in the replay.
    sweepAllPayloads(rig);
  }, 30_000);

  it('completes the game after a player vanishes forever — auto-defaults cover him', async () => {
    const { rig, clients, roomCode, tokens } = await startFullRoom();

    // Seat 6's socket dies before the game even begins to matter.
    const vanished = clients[5];
    const vanishedSeat = vanished.rec.latest?.you.seat;
    vanished.client.disconnect();

    // The remaining 11 view-driven clients finish the whole game.
    await playScriptedGame(rig, 50_000);

    const active = clients.filter((c) => c !== vanished);
    for (const c of active) {
      expect(c.rec.latest?.phase).toBe('game-over');
      expect(c.rec.latest?.winner).not.toBeNull();
    }
    // The vanished seat still exists in the final state and the token
    // still reattaches — as a spectator-grade view after game over.
    const survivorView = active[0].rec.latest;
    expect(survivorView?.players.some((p) => p.seat === vanishedSeat)).toBe(true);

    const revived = await connect(rig);
    const ack = await rejoinRoom(revived.client, roomCode, tokens[5]);
    expect(ack.seat).toBe(vanishedSeat);
    await waitFor(() => revived.rec.latest !== null);
    expect(revived.rec.latest?.phase).toBe('game-over');
    expect(revived.rec.latest?.players.every((p) => p.role !== null)).toBe(true);
    sweepAllPayloads(rig);
  }, 60_000);
});
