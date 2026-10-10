import { afterEach, describe, expect, it } from 'vitest';
import type { Seat } from '@werewolf/engine';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  rejoinRoom,
  scriptTimers,
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

async function freshRig(...args: Parameters<typeof startServer>): Promise<Rig> {
  const rig = await startServer(...args);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

/** The client in `pool` whose own view says the current speech slot is theirs. */
function currentSpeakerIn(pool: Connected[]): { client: Connected['client']; seat: Seat } | null {
  for (const { client, rec } of pool) {
    const view = rec.latest;
    if (!view || view.phase !== 'speech' || view.step.kind !== 'speech') continue;
    if (!view.step.order) continue;
    const slotSeat = view.step.order[view.step.cursor];
    if (slotSeat !== undefined && slotSeat === view.you.seat) return { client, seat: slotSeat };
  }
  return null;
}

/** Seats occupied in a recorder's latest view — the lobby's room fingerprint. */
function occupiedSeats(rec: Connected['rec']): number[] {
  const view = rec.latest;
  if (!view) return [];
  return view.players
    .filter((p) => p.occupied)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
}

describe('one room per socket — the rebind invariant', () => {
  it('a socket rebinding A→B receives no further room-A views, events, or voice relay', async () => {
    const rig = await freshRig({ ...scriptTimers(), speech: 2500 });

    // Two lobbies on one server: X creates room A, Y creates room B, and
    // room A fills to twelve seats.
    const x = await connect(rig);
    const roomA = await createRoom(x.client);
    const y = await connect(rig);
    const roomB = await createRoom(y.client);
    const joiners = await connectAll(rig, 11);
    for (const j of joiners) await joinRoom(j.client, roomA.roomCode);

    // The attack: X, still seated in A, binds its socket to room B.
    const bJoin = await joinRoom(x.client, roomB.roomCode);
    expect('spectator' in bJoin).toBe(false);
    await sleep(100); // room B's join-occupancy view is the last thing X may hear

    const views0 = x.rec.views.length;
    const events0 = x.rec.events.length;
    const voice0 = x.rec.voiceChunks.length;

    // Room A's game runs on without X's wire identity — any seated player
    // may start (the documented product model), and compact clocks carry
    // night 1 through to the day floor.
    const starter = joiners[0];
    if (!starter) throw new Error('rig setup: missing starter');
    await startRoom(starter.client);
    await waitFor(() => currentSpeakerIn(joiners) !== null, 20_000);
    const speaker = currentSpeakerIn(joiners);
    if (!speaker) throw new Error('rig setup: no speech slot opened');

    // The relay demonstrably runs for room A's members...
    const frame = new TextEncoder().encode('fake-pcm-audio').buffer as ArrayBuffer;
    for (let i = 0; i < 3; i++) speaker.client.emit('voice:frame', frame);
    await waitFor(
      () => joiners.some((j) => j.rec.voiceChunks.some((c) => c.seat === speaker.seat)),
      5000,
    );

    // ...but the rebound socket heard none of room A: no voice, no events,
    // no views — not even anything projected for the seat its stale
    // membership would have referenced.
    expect(x.rec.voiceChunks.length).toBe(voice0);
    expect(x.rec.events.length).toBe(events0);
    expect(x.rec.views.length).toBe(views0);
    sweepAllPayloads(rig);
  }, 30_000);

  it('rejoining room A after the rebind unbind restores the normal view stream', async () => {
    const rig = await freshRig({ ...scriptTimers(), speech: 2500 });

    const x = await connect(rig);
    const roomA = await createRoom(x.client);
    const y = await connect(rig);
    const roomB = await createRoom(y.client); // room B — the rebind target
    const joiners = await connectAll(rig, 10);
    for (const j of joiners) await joinRoom(j.client, roomA.roomCode);

    // X leaves A's fan-out by binding its socket to room B.
    await joinRoom(x.client, roomB.roomCode);
    await sleep(100);

    // ...and returns to A with the original token: the seat is still his,
    // and the view stream must come back intact.
    const back = await rejoinRoom(x.client, roomA.roomCode, roomA.sessionToken);
    expect(back.seat).toBe(1);
    expect(occupiedSeats(x.rec)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // A later joiner takes the last seat; X hears the occupancy broadcast again.
    const late = await connect(rig);
    await joinRoom(late.client, roomA.roomCode);
    await waitFor(() => occupiedSeats(x.rec).length === 12, 5000);
    expect(x.rec.latest?.you.seat).toBe(1);

    const starter = joiners[0];
    if (!starter) throw new Error('rig setup: missing starter');
    await startRoom(starter.client);
    await waitFor(() => x.rec.events.length > 0, 5000);
    await waitFor(() => x.rec.latest?.phase !== 'lobby', 5000);
    sweepAllPayloads(rig);
  }, 30_000);
});
