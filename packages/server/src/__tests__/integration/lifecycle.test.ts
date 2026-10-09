import { afterEach, describe, expect, it } from 'vitest';
import type { Seat } from '@werewolf/engine';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  rejoinRoom,
  sendRaw,
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

describe('room lifecycle over real sockets', () => {
  it('seats 12 players with join codes and unique session tokens', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const { roomCode } = await createRoom(creator);
    expect(roomCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);

    const seats: Seat[] = [];
    const tokens = new Set<string>();
    for (const joined of await connectAll(rig, 11)) {
      const ack = await joinRoom(joined.client, roomCode);
      if ('spectator' in ack) throw new Error('unexpected spectator join');
      seats.push(ack.seat);
      tokens.add(ack.sessionToken);
    }
    expect(seats).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(tokens.size).toBe(11);
    // The creator's own ack carries seat 1 and a token of its own.
    expect(rig.recs[0]?.latest?.you.seat).toBe(1);
  }, 10_000);

  it('rejects a 13th join with ROOM_FULL and unknown codes with ROOM_NOT_FOUND', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const { roomCode } = await createRoom(creator);
    const joiners = await connectAll(rig, 11);
    for (const j of joiners) await joinRoom(j.client, roomCode);

    const thirteenth = await connect(rig);
    await expect(joinRoom(thirteenth.client, roomCode)).rejects.toThrow('ROOM_FULL');

    const stranger = await connect(rig);
    await expect(joinRoom(stranger.client, 'ZZZZ')).rejects.toThrow('ROOM_NOT_FOUND');
  }, 10_000);

  it('rejects a mid-game join with GAME_RUNNING', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const { roomCode } = await createRoom(creator);
    const joiners = await connectAll(rig, 11);
    for (const j of joiners) await joinRoom(j.client, roomCode);
    await startRoom(creator);
    await waitFor(() => rig.recs.every((r) => r.latest?.phase === 'night'));

    const late = await connect(rig);
    await expect(joinRoom(late.client, roomCode)).rejects.toThrow('GAME_RUNNING');
  }, 10_000);

  it('reattaches a seat from its session token with a fresh full view', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);
    const { client: joiner } = await connect(rig);
    await joinRoom(joiner, created.roomCode);

    // Simulate a refresh: kill the socket, then rejoin with the token.
    creator.disconnect();
    const revived = await connect(rig);
    const ack = await rejoinRoom(revived.client, created.roomCode, created.sessionToken);
    expect(ack.seat).toBe(1);
    // The reattached socket receives a fresh view addressed to its seat.
    await waitFor(() => revived.rec.latest?.you.seat === 1);
    expect(revived.rec.latest?.phase).toBe('lobby');

    // Wrong tokens are rejected.
    const stranger = await connect(rig);
    await expect(rejoinRoom(stranger.client, created.roomCode, 'nope')).rejects.toThrow(
      'BAD_TOKEN',
    );
  }, 10_000);

  it('maps protocol violations to per-socket game:error, never a disconnect', async () => {
    const rig = await freshRig();
    const { client: creator, rec: creatorRec } = await connect(rig);
    const created = await createRoom(creator);
    const { client: joiner, rec: joinerRec } = await connect(rig);
    const joined = await joinRoom(joiner, created.roomCode);
    if ('spectator' in joined) throw new Error('unexpected spectator join');

    // Seat 2 acts as seat 5.
    joiner.emit('game:action', { type: 'EXILE_VOTE', actor: 5, target: 1 });
    // START_GAME from a socket is forbidden.
    sendRaw(creator, { type: 'START_GAME' });
    // Malformed payload: the actor is not a seat number.
    sendRaw(creator, { type: 'WOLF_KILL', actor: 'wolf' });
    // Actions while in the lobby are wrong-phase errors.
    joiner.emit('game:action', { type: 'SPEAK', actor: joined.seat, text: 'too early' });

    await waitFor(() => creatorRec.errors.length + joinerRec.errors.length >= 4, 3000);
    const codes = [...creatorRec.errors, ...joinerRec.errors].map((e) => e.code);
    expect(codes).toContain('NOT_YOUR_SEAT');
    expect(codes).toContain('SERVER_ACTION_FORBIDDEN');
    expect(codes).toContain('BAD_ACTION');
    expect(codes).toContain('WRONG_PHASE');
    // Nobody was disconnected by any of it.
    expect(rig.clients.every((c) => c.connected)).toBe(true);
  }, 10_000);
});
