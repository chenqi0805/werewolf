import { afterEach, describe, expect, it } from 'vitest';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  startRoom,
  startServer,
  stopServer,
  waitFor,
  type Rig,
} from './helpers';

const rigs: Rig[] = [];

async function freshRig(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

describe('phase timers with injected defaults', () => {
  it('advances the game for days with nobody acting — 空刀 nights, abstained votes', async () => {
    const rig = await freshRig();
    const creator = await connect(rig);
    const { roomCode } = await createRoom(creator.client);
    const joiners = await connectAll(rig, 11);
    for (const j of joiners) await joinRoom(j.client, roomCode);
    await startRoom(creator.client);

    // Not a single client sends an action. The server must keep the game
    // moving: empty-knife nights, potion passes, void elections, abstained
    // exile votes, day after day.
    await waitFor(() => rig.recs.some((r) => (r.latest?.dayNumber ?? 0) >= 4), 40_000);

    // The table really passed through every canonical phase.
    const phases = new Set(rig.recs.flatMap((r) => r.views.map((v) => v.phase)));
    expect(phases.has('night')).toBe(true);
    expect(phases.has('sheriff-signup')).toBe(true);
    expect(phases.has('dawn-announce')).toBe(true);
    expect(phases.has('speech')).toBe(true);
    expect(phases.has('exile-vote')).toBe(true);

    // Pure timer flow produces zero protocol errors.
    expect(rig.recs.every((r) => r.errors.length === 0)).toBe(true);
  }, 50_000);

  it('keeps advancing indefinitely under total passivity — no stall, no deadlock', async () => {
    // Wolves never kill (空刀), nobody is ever exiled — the game never ends,
    // but the clock must keep it phase-legal and moving forever.
    const rig = await freshRig();
    const creator = await connect(rig);
    const { roomCode } = await createRoom(creator.client);
    const joiners = await connectAll(rig, 11);
    for (const j of joiners) await joinRoom(j.client, roomCode);
    await startRoom(creator.client);

    await waitFor(() => rig.recs.some((r) => (r.latest?.dayNumber ?? 0) >= 8), 60_000);
    const seen = rig.recs.map((r) => r.latest?.dayNumber ?? 0);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(8);
    // And the game has not deadlocked or errored at any point.
    expect(rig.recs.every((r) => r.errors.length === 0)).toBe(true);
  }, 70_000);
});
