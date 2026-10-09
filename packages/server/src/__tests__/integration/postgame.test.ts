import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientToServerEvents, ServerToClientEvents } from '../../index';
import type { PostgameReply } from '../../postgame';
import type { Socket } from 'socket.io-client';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  playScriptedGame,
  scriptTimers,
  startRoom,
  startServer,
  stopServer,
  sweepAllPayloads,
  waitFor,
  type Rig,
} from './helpers';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const rigs: Rig[] = [];

async function freshRig(...args: Parameters<typeof startServer>): Promise<Rig> {
  const rig = await startServer(...args);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

/** A full 12-seat table with no client actions — compact clocks run the game. */
async function seatTwelve(rig: Rig): Promise<void> {
  const creator = await connect(rig);
  const { roomCode } = await createRoom(creator.client);
  const joiners = await connectAll(rig, 11);
  for (const j of joiners) await joinRoom(j.client, roomCode);
  await startRoom(creator.client);
}

function askPostgame(client: Client): Promise<PostgameReply | { error: string }> {
  return new Promise((resolve) => client.emit('postgame:analysis', resolve));
}

const REPLY: PostgameReply = {
  summary: '狼人白天带节奏,好人被逐个击破,最终屠边获胜。',
  keyMoments: ['首夜狼刀带走5号', '警长选举9号当选', '7号被放逐出局', '最后一夜屠边'],
  mvp: 1,
  ratings: Array.from({ length: 12 }, (_, i) => ({
    seat: i + 1,
    score: 5,
    rationale: `第${i + 1}号的发挥中规中矩`,
    highlight: `第${i + 1}号的一次关键发言`,
  })),
};

function anthropicFetch(reply: string) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text: reply }] }), {
    status: 200,
  });
}

describe('postgame:analysis over real sockets', () => {
  it('one cached generation per room: concurrent requests share one provider call, repeats are free', async () => {
    const gate: { release?: () => void } = {};
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return anthropicFetch(JSON.stringify(REPLY));
    });
    vi.stubGlobal('fetch', fetchMock);

    const rig = await freshRig(scriptTimers(), { postgame: { anthropicApiKey: 'sk-cloud' } });
    await seatTwelve(rig);
    await playScriptedGame(rig, 50_000);
    await waitFor(() => rig.recs.every((r) => r.latest?.phase === 'game-over'), 10_000);

    // Two viewers arm the generation at once — they must join one call.
    const firstAck = askPostgame(rig.clients[0] as Client);
    const secondAck = askPostgame(rig.clients[1] as Client);
    await waitFor(() => gate.release !== undefined, 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    gate.release?.();
    expect(await firstAck).toEqual(REPLY);
    expect(await secondAck).toEqual(REPLY);

    // Post-completion repeats are served from the cache — no second call.
    const repeatAck = await askPostgame(rig.clients[2] as Client);
    expect(repeatAck).toEqual(REPLY);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Every viewer records the same shared reply, and the sweep confirms the
    // ack carries nothing but the validated shape.
    for (const rec of rig.recs) rec.acks.push(REPLY);
    sweepAllPayloads(rig);
  }, 70_000);

  it('acks NOT_GAME_OVER on a live room without calling the provider', async () => {
    const fetchMock = vi.fn(async () => anthropicFetch(JSON.stringify(REPLY)));
    vi.stubGlobal('fetch', fetchMock);

    const rig = await freshRig(scriptTimers(), { postgame: { anthropicApiKey: 'sk-cloud' } });
    await seatTwelve(rig);
    await waitFor(() => rig.recs.every((r) => r.latest !== null), 10_000);
    const ack = await askPostgame(rig.clients[0] as Client);
    expect(ack).toEqual({ error: 'NOT_GAME_OVER' });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it('acks ASSISTANT_UNAVAILABLE after a finished game with no provider configured', async () => {
    const fetchMock = vi.fn(async () => anthropicFetch(JSON.stringify(REPLY)));
    vi.stubGlobal('fetch', fetchMock);

    const rig = await freshRig(scriptTimers(), {});
    await seatTwelve(rig);
    await playScriptedGame(rig, 50_000);
    await waitFor(() => rig.recs.every((r) => r.latest?.phase === 'game-over'), 10_000);
    const ack = await askPostgame(rig.clients[0] as Client);
    expect(ack).toEqual({ error: 'ASSISTANT_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 70_000);

  it('acks NOT_IN_ROOM for a socket that never joined', async () => {
    const fetchMock = vi.fn(async () => anthropicFetch(JSON.stringify(REPLY)));
    vi.stubGlobal('fetch', fetchMock);

    const rig = await freshRig(scriptTimers(), { postgame: { anthropicApiKey: 'sk-cloud' } });
    const bystander = await connect(rig);
    const ack = await askPostgame(bystander.client);
    expect(ack).toEqual({ error: 'NOT_IN_ROOM' });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);
});
