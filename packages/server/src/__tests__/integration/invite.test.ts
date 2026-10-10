import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailSender } from '../../invites';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  leaveRoom,
  startRoom,
  startServer,
  stopServer,
  waitFor,
  type Client,
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

/** Emits room:invite and resolves with the ack — typed through the gateway. */
function invite(client: Client, email: string): Promise<{ ok: true } | { error: string }> {
  return new Promise((resolve) => client.emit('room:invite', email, resolve));
}

/** A two-seat lobby: creator (seat 1) plus one friend. Returns the room code. */
async function openLobby(rig: Rig): Promise<string> {
  const creator = await connect(rig);
  const { roomCode } = await createRoom(creator.client);
  const friend = await connect(rig);
  await joinRoom(friend.client, roomCode);
  await waitFor(() => rig.recs.every((r) => r.latest !== null));
  return roomCode;
}

describe('room:invite over real sockets', () => {
  it('delivers the invite with the room code and full join link, and hints the lobby', async () => {
    const sent: Array<{ to: string; subject: string; html: string }> = [];
    const sendImpl: MailSender = async (mail) => void sent.push(mail);
    const rig = await freshRig(undefined, {
      invites: {
        baseUrl: 'https://werewolf.example',
        from: 'invites@werewolf.example',
        sendImpl,
      },
    });
    const roomCode = await openLobby(rig);

    // The lobby view carries the capability hint — no extra round trip.
    for (const rec of rig.recs) {
      expect(rec.latest?.inviteAvailable).toBe(true);
    }

    const creator = rig.clients[0];
    if (!creator) throw new Error('no creator client');
    expect(await invite(creator, 'friend@example.com')).toEqual({ ok: true });
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('friend@example.com');
    expect(sent[0]?.subject).toContain(roomCode);
    expect(sent[0]?.html).toContain(`https://werewolf.example/?room=${roomCode}`);
  }, 15000);

  it('hides the affordance and acks INVITE_UNAVAILABLE when unconfigured', async () => {
    const rig = await freshRig();
    await openLobby(rig);
    for (const rec of rig.recs) {
      expect(rec.latest?.inviteAvailable).toBeFalsy();
    }
    const creator = rig.clients[0];
    if (!creator) throw new Error('no creator client');
    expect(await invite(creator, 'friend@example.com')).toEqual({
      error: 'INVITE_UNAVAILABLE',
    });
  }, 15000);

  it('refuses unseated sockets with NOT_IN_ROOM', async () => {
    const rig = await freshRig(undefined, {
      invites: { baseUrl: 'https://werewolf.example', from: 'a@b.c', sendImpl: async () => {} },
    });
    // A client that connected but never joined a room.
    const loner = await connect(rig);
    expect(await invite(loner.client, 'friend@example.com')).toEqual({ error: 'NOT_IN_ROOM' });
  }, 15000);

  it('rejects malformed addresses with INVALID_EMAIL over the real socket', async () => {
    const sendImpl: MailSender = vi.fn(async () => {});
    const rig = await freshRig(undefined, {
      invites: { baseUrl: 'https://werewolf.example', from: 'a@b.c', sendImpl },
    });
    await openLobby(rig);
    const creator = rig.clients[0];
    if (!creator) throw new Error('no creator client');
    expect(await invite(creator, 'friend@example')).toEqual({ error: 'INVALID_EMAIL' });
    expect(sendImpl).not.toHaveBeenCalled();
  }, 15000);

  it('enforces the per-seat lobby budget over the real gateway', async () => {
    const sendImpl = vi.fn(async () => {});
    const rig = await freshRig(undefined, {
      invites: {
        baseUrl: 'https://werewolf.example',
        from: 'a@b.c',
        sendImpl,
        maxInvitesPerLobby: 1,
      },
    });
    await openLobby(rig);
    const creator = rig.clients[0];
    if (!creator) throw new Error('no creator client');
    expect(await invite(creator, 'a@example.com')).toEqual({ ok: true });
    expect(await invite(creator, 'b@example.com')).toEqual({ error: 'INVITE_RATE_LIMITED' });
    expect(sendImpl).toHaveBeenCalledTimes(1);
  }, 15000);

  it('acks GAME_RUNNING for a mid-game invite and leaves the budget untouched', async () => {
    const sendImpl = vi.fn(async () => {});
    const rig = await freshRig(undefined, {
      invites: {
        baseUrl: 'https://werewolf.example',
        from: 'a@b.c',
        sendImpl,
        maxInvitesPerLobby: 1,
      },
    });
    const creator = await connect(rig);
    const { roomCode } = await createRoom(creator.client);
    const joiners = await connectAll(rig, 11);
    for (const j of joiners) await joinRoom(j.client, roomCode);
    await waitFor(() => rig.recs.every((r) => r.latest !== null));

    // The lobby send maxes seat 1's budget (1/1) while the room is joinable.
    const creatorClient = rig.clients[0];
    if (!creatorClient) throw new Error('no creator client');
    expect(await invite(creatorClient, 'lobby@example.com')).toEqual({ ok: true });
    await startRoom(creator.client);

    // The mid-game ask is rejected by the phase gate — GAME_RUNNING, not
    // INVITE_RATE_LIMITED, proving the gate runs before any budget
    // consultation on a maxed budget.
    expect(await invite(creatorClient, 'midgame@example.com')).toEqual({
      error: 'GAME_RUNNING',
    });
    expect(sendImpl).toHaveBeenCalledTimes(1);
  }, 15000);

  it('gives a freed seat a fresh budget: exhaust, quit, rejoin, send', async () => {
    const sendImpl = vi.fn(async () => {});
    const rig = await freshRig(undefined, {
      invites: {
        baseUrl: 'https://werewolf.example',
        from: 'a@b.c',
        sendImpl,
        maxInvitesPerLobby: 1,
      },
    });
    const creator = await connect(rig);
    const { roomCode } = await createRoom(creator.client);
    const joinerB = await connect(rig);
    await joinRoom(joinerB.client, roomCode); // seat 2
    const joinerC = await connect(rig);
    await joinRoom(joinerC.client, roomCode); // seat 3
    await waitFor(() => rig.recs.every((r) => r.latest !== null));

    // Both seats spend their lobby budgets (1/1 each) while the room is
    // joinable; seat 3 then quits through the real room:leave path — the
    // gateway frees the seat and its budget with it.
    const seatThree = rig.clients[2];
    if (!seatThree) throw new Error('no seat-3 client');
    const creatorClient = rig.clients[0];
    if (!creatorClient) throw new Error('no creator client');
    expect(await invite(creatorClient, 'creator@example.com')).toEqual({ ok: true });
    expect(await invite(seatThree, 'first@example.com')).toEqual({ ok: true });
    expect(await invite(seatThree, 'second@example.com')).toEqual({
      error: 'INVITE_RATE_LIMITED',
    });
    await leaveRoom(seatThree);

    // A new player takes the freed seat 3 and their first invite sends —
    // the spent budget belonged to the previous occupant, not the seat.
    const next = await connect(rig);
    const ack = await joinRoom(next.client, roomCode);
    if ('spectator' in ack) throw new Error('unexpected spectator join');
    expect(ack.seat).toBe(3);
    expect(await invite(next.client, 'fresh@example.com')).toEqual({ ok: true });
    // Seat 1's spent budget was untouched by the seat-3 clear.
    expect(await invite(creatorClient, 'again@example.com')).toEqual({
      error: 'INVITE_RATE_LIMITED',
    });
    expect(sendImpl).toHaveBeenCalledTimes(3);
  }, 15000);
});
