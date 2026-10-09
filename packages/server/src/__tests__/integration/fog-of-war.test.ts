import { afterEach, describe, expect, it } from 'vitest';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  playScriptedGame,
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

async function startFullRoom(rig: Rig): Promise<{ clients: Connected[]; roomCode: string }> {
  const creator = await connect(rig);
  const { roomCode } = await createRoom(creator.client);
  const joiners = await connectAll(rig, 11);
  for (const j of joiners) await joinRoom(j.client, roomCode);
  await startRoom(creator.client);
  return { clients: [creator, ...joiners], roomCode };
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

describe('fog of war over real sockets', () => {
  it('plays a full random game with zero unrevealed-role leakage anywhere', async () => {
    const rig = await freshRig();
    const { roomCode } = await startFullRoom(rig);

    // The whole game runs view-driven: every action comes from what that
    // client itself can see, over a random deck, through real sockets.
    await playScriptedGame(rig, 50_000);

    for (const rec of rig.recs) {
      expect(rec.latest?.phase).toBe('game-over');
      expect(rec.latest?.winner).not.toBeNull();
    }
    // Every client observed the same verdict.
    const winners = new Set(rig.recs.map((r) => r.latest?.winner));
    expect(winners.size).toBe(1);

    sweepAllPayloads(rig);

    // Seer results reached exactly one socket — the seer's.
    const seerSeat = rig.recs
      .flatMap((r) => r.latest?.players ?? [])
      .find((p) => p.role === 'seer')?.seat;
    expect(seerSeat).toBeDefined();
    const seerIdx = rig.recs.findIndex((r) => r.latest?.you.seat === seerSeat);
    expect(seerIdx).toBeGreaterThanOrEqual(0);
    const perSocket = rig.recs.map((r) => r.events.filter((e) => e.type === 'SEER_CHECKED').length);
    const totalSeerEvents = perSocket.reduce((a, b) => a + b, 0);
    expect(totalSeerEvents).toBeGreaterThan(0);
    for (let i = 0; i < perSocket.length; i++) {
      if (i === seerIdx) expect(perSocket[i]).toBe(totalSeerEvents);
      else expect(perSocket[i]).toBe(0);
    }

    // Wolves always saw the whole pack in their own views.
    const wolfSeats = (rig.recs[0].latest?.players ?? [])
      .filter((p) => p.role === 'werewolf')
      .map((p) => p.seat);
    for (const rec of rig.recs) {
      const seat = rec.latest?.you.seat;
      if (seat === null || seat === undefined || !wolfSeats.includes(seat)) continue;
      const sawPack = rec.views.some(
        (v) =>
          v.you.wolfPack?.length === wolfSeats.length &&
          wolfSeats.every((ws) => v.players.find((r) => r.seat === ws)?.role === 'werewolf'),
      );
      expect(sawPack, `wolf seat ${seat} never saw its pack`).toBe(true);
    }

    // A late spectator lands with the complete reveal.
    const spectator = await connect(rig);
    const ack = await joinRoom(spectator.client, roomCode);
    expect('spectator' in ack && ack.spectator).toBe(true);
    await waitFor(() => spectator.rec.latest !== null);
    expect(spectator.rec.latest?.phase).toBe('game-over');
    expect(spectator.rec.latest?.winner).not.toBeNull();
    expect(spectator.rec.latest?.players.every((r) => r.role !== null)).toBe(true);
  }, 60_000);
});
