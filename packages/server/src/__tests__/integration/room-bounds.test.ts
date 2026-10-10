import { afterEach, describe, expect, it } from 'vitest';
import type { CreateAck, JoinAck } from '../../index';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  scriptTimers,
  sleep,
  startServer,
  stopServer,
  waitFor,
  type Client,
  type Rig,
} from './helpers';

const rigs: Rig[] = [];

async function freshRig(extra: Partial<Parameters<typeof startServer>[1]> = {}): Promise<Rig> {
  const rig = await startServer(scriptTimers(), extra);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

/** Resolves the raw create ack — the error-code assertions need the value. */
function tryCreate(socket: Client): Promise<CreateAck | { error: string }> {
  return new Promise((resolve) => {
    socket.emit('room:create', {}, (resp) => resolve(resp));
  });
}

/** Resolves the raw join ack — same reason. */
function tryJoin(socket: Client, code: string): Promise<JoinAck | { error: string }> {
  return new Promise((resolve) => {
    socket.emit('room:join', code, '', (resp) => resolve(resp));
  });
}

function errorOf(resp: CreateAck | { error: string } | JoinAck | { error: string }): string | null {
  return 'error' in resp ? resp.error : null;
}

describe('per-IP create budget (F2)', () => {
  it('rejects the 11th create in the window with a stable code', async () => {
    const rig = await freshRig();
    const { client } = await connect(rig);
    // All attempts share one loopback IP — exactly the shared-bucket shape.
    for (let i = 0; i < 10; i++) {
      const resp = await tryCreate(client);
      expect(errorOf(resp), `create #${i + 1}`).toBeNull();
    }
    expect(errorOf(await tryCreate(client))).toBe('RATE_LIMITED');
  });
});

describe('per-IP join budget (F2; deflates the F9 oracle)', () => {
  it('fires before the room lookup: spent probes rate-limit a real join', async () => {
    const rig = await freshRig();
    const { client: seated } = await connect(rig);
    const created = await createRoom(seated);
    const { client } = await connect(rig);
    // 30 failed probes on a nonexistent code, each spending the bucket.
    for (let i = 0; i < 30; i++) {
      const resp = await tryJoin(client, 'ZZZZ');
      expect(errorOf(resp), `probe #${i + 1}`).toBe('ROOM_NOT_FOUND');
    }
    // The 31st attempt targets a real room. A limiter that ran after the
    // lookup would have joined it; RATE_LIMITED proves it runs before.
    const resp = await tryJoin(client, created.roomCode);
    expect(errorOf(resp)).toBe('RATE_LIMITED');
  });
});

describe('global live-lobby ceiling (F2)', () => {
  it('acks ROOM_LIMIT for the 201st occupied room, minting nothing', async () => {
    // Create/join budgets are relaxed so only the ceiling is under test;
    // omitted keys keep their defaults — maxLiveRooms stays 200.
    const rig = await freshRig({ limits: { createPerWindow: 1000, joinPerWindow: 1000 } });
    const seats = await connectAll(rig, 201);
    const overflow = seats.at(200);
    if (overflow === undefined) throw new Error('missing the 201st socket');
    for (const { client } of seats.slice(0, 200)) {
      const resp = await tryCreate(client);
      expect(errorOf(resp)).toBeNull();
    }
    const resp = await tryCreate(overflow.client);
    expect(errorOf(resp)).toBe('ROOM_LIMIT');
  }, 30_000);
});

describe('empty-lobby TTL (F2)', () => {
  it('evicts a room whose last socket left, releasing the code', async () => {
    const rig = await freshRig({ limits: { createPerWindow: 100, emptyLobbyTtlMs: 150 } });
    const { client } = await connect(rig);
    const created = await createRoom(client);
    client.disconnect();
    await waitFor(() => rig.app.registry.get(created.roomCode) === undefined);
    // Released: joins to the evicted code now answer ROOM_NOT_FOUND.
    const { client: stranger } = await connect(rig);
    expect(errorOf(await tryJoin(stranger, created.roomCode))).toBe('ROOM_NOT_FOUND');
  }, 15_000);

  it('an occupant return cancels the pending eviction', async () => {
    const rig = await freshRig({
      limits: { createPerWindow: 100, joinPerWindow: 100, emptyLobbyTtlMs: 150 },
    });
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);
    creator.disconnect();
    // Reoccupy before the TTL fires; the returning socket re-arms nothing.
    const { client: reoccupant } = await connect(rig);
    const joinAck = await joinRoom(reoccupant, created.roomCode);
    if ('spectator' in joinAck) throw new Error('unexpected spectator join');
    await sleep(300); // well past the TTL
    expect(rig.app.registry.get(created.roomCode)).toBeDefined();
  }, 15_000);
});
