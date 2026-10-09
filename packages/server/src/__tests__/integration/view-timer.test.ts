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
  waitFor,
  type Rig,
} from './helpers';

const rigs: Rig[] = [];

async function seatTwelve(rig: Awaited<ReturnType<typeof startServer>>, code: string): Promise<void> {
  for (const joined of await connectAll(rig, 11)) await joinRoom(joined.client, code);
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

describe('phase deadline surfaced in views', () => {
  it('omits the deadline in the lobby, where no clock runs', async () => {
    const rig = await startServer();
    rigs.push(rig);
    const { client: creator, rec } = await connect(rig);
    await createRoom(creator);
    expect(rec.latest?.timer).toBeNull();
  }, 10_000);

  it('carries the active step deadline once the game starts', async () => {
    const rig = await startServer({ 'night:wolf': 3000 });
    rigs.push(rig);
    const { client: creator, rec } = await connect(rig);
    const created = await createRoom(creator);
    await seatTwelve(rig, created.roomCode);

    const t0 = Date.now();
    await startRoom(creator);
    await waitFor(() => rec.latest?.phase === 'night');

    const timer = rec.latest?.timer;
    expect(timer).toEqual({ key: 'night:wolf', endsAt: expect.any(Number) });
    // The deadline reflects the configured 3000ms wolf clock, not the default.
    expect(timer?.endsAt).toBeGreaterThanOrEqual(t0 + 2500);
    expect(timer?.endsAt).toBeLessThanOrEqual(t0 + 3100);
  }, 10_000);

  it('clears the deadline once the game is over', async () => {
    const rig = await startServer();
    rigs.push(rig);
    const { client: creator, rec } = await connect(rig);
    const created = await createRoom(creator);
    await seatTwelve(rig, created.roomCode);
    await startRoom(creator);

    await playScriptedGame(rig);

    expect(rec.latest?.phase).toBe('game-over');
    expect(rec.latest?.timer).toBeNull();
    for (const other of rig.recs) {
      expect(other.latest?.timer).toBeNull();
    }
  }, 30_000);
});
