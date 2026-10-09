import { afterEach, describe, expect, it } from 'vitest';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  leaveRoom,
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

function occupiedOf(rig: Rig, index: number): number | undefined {
  return rig.recs[index]?.latest?.players.filter((r) => r.occupied).length;
}

describe('lobby leave over real sockets', () => {
  it('broadcasts occupancy on join and frees the seat on leave', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);

    // The creator's view follows the join — occupancy is broadcast, not private.
    const { client: joiner } = await connect(rig);
    const joinAck = await joinRoom(joiner, created.roomCode);
    if ('spectator' in joinAck) throw new Error('unexpected spectator join');
    await waitFor(() => occupiedOf(rig, 0) === 2);

    // Quitting frees the seat: the remaining client sees it empty again.
    await leaveRoom(joiner);
    await waitFor(() => occupiedOf(rig, 0) === 1);
    expect(rig.recs[0]?.latest?.players.find((r) => r.seat === joinAck.seat)?.occupied).toBe(false);

    // The freed seat goes back to the pool — lowest free seat wins.
    const next = await connect(rig);
    const ack = await joinRoom(next.client, created.roomCode);
    if ('spectator' in ack) throw new Error('unexpected spectator join');
    expect(ack.seat).toBe(joinAck.seat);
  }, 10_000);

  it('a leaver holds nothing: no actions, no reattach', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);
    const { client: joiner } = await connect(rig);
    const joinAck = await joinRoom(joiner, created.roomCode);
    if (!('sessionToken' in joinAck)) throw new Error('unexpected spectator join');
    await leaveRoom(joiner);

    sendRaw(joiner, { type: 'SPEAK', actor: joinAck.seat, text: 'ghost speech' });
    await waitFor(() => (rig.recs[1]?.errors.length ?? 0) > 0);
    expect(rig.recs[1]?.errors[0]?.code).toBe('NOT_IN_ROOM');

    // The token died with the seat: reattach fails.
    await expect(rejoinRoom(joiner, created.roomCode, joinAck.sessionToken)).rejects.toThrow(
      'BAD_TOKEN',
    );
  }, 10_000);

  it('keeps the room joinable when the last human leaves', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);
    await leaveRoom(creator);

    const next = await connect(rig);
    const ack = await joinRoom(next.client, created.roomCode);
    if ('spectator' in ack) throw new Error('unexpected spectator join');
    expect(ack.seat).toBe(1);
  }, 10_000);

  it('rejects a leave once the game has started — mid-game semantics unchanged', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);
    const joiners = await connectAll(rig, 11);
    for (const j of joiners) await joinRoom(j.client, created.roomCode);
    await startRoom(creator);
    await waitFor(() => rig.recs.every((r) => r.latest?.phase === 'night'));

    const first = joiners[0];
    if (!first) throw new Error('missing joiner');
    await expect(leaveRoom(first.client)).rejects.toThrow('ALREADY_STARTED');
  }, 10_000);
});
