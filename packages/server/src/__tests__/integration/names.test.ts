import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateAck, JoinAck } from '../../index';
import {
  connect,
  createRoom,
  joinRoom,
  rejoinRoom,
  scriptTimers,
  startServer,
  stopServer,
  waitFor,
  type Client,
  type Rig,
} from './helpers';

/**
 * Join-time display names at the gateway level: the name payload rides
 * room:create / room:join, the ack echoes what stuck, every seat view
 * carries it, reattach returns it, and a restart cannot lose it.
 */

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

/** Untyped join emit for payloads the typed client cannot express. */
function joinRaw(socket: Client, ...args: unknown[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    (socket.emit as unknown as (event: string, ...a: unknown[]) => void)(
      'room:join',
      ...args,
      resolve,
    );
  });
}

/** Narrow a join ack to the seated branch — this suite never expects spectators. */
function expectSeated(ack: JoinAck): asserts ack is CreateAck {
  if ('spectator' in ack) throw new Error('unexpected spectator join');
}

describe('join-time display names over real sockets', () => {
  it('carries the creator and joiner names onto every seat view', async () => {
    const rig = await freshRig();
    const { client: creator, rec: creatorRec } = await connect(rig);
    const created = await createRoom(creator, undefined, '阿明');
    expect(created.name).toBe('阿明');

    const { client: joiner } = await connect(rig);
    const joined = await joinRoom(joiner, created.roomCode, '小美');
    expectSeated(joined);
    expect(joined.name).toBe('小美');

    // Names are public lobby information — the creator's own view carries both.
    await waitFor(() => creatorRec.latest?.players.find((r) => r.seat === 2)?.name === '小美');
    const rows = creatorRec.latest?.players ?? [];
    expect(rows.find((r) => r.seat === 1)?.name).toBe('阿明');
    expect(rows.find((r) => r.seat === 2)?.name).toBe('小美');
  }, 10_000);

  it('returns the stored name when a session reattaches', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator, undefined, '阿明');
    creator.disconnect();

    // Simulate a refresh: the token comes back, and so does the name.
    const revived = await connect(rig);
    const ack = await rejoinRoom(revived.client, created.roomCode, created.sessionToken);
    expect(ack).toMatchObject({ seat: 1, name: '阿明' });
    await waitFor(() => revived.rec.latest?.you.seat === 1);
    expect(revived.rec.latest?.players.find((r) => r.seat === 1)?.name).toBe('阿明');
  }, 10_000);

  it('trims and caps names without ever rejecting the join', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);
    const code = created.roomCode;

    const first = await connect(rig);
    const trimmed = await joinRoom(first.client, code, '  阿明  ');
    expectSeated(trimmed);
    expect(trimmed.name).toBe('阿明');

    const second = await connect(rig);
    const truncated = await joinRoom(second.client, code, '一二三四五六七八九十甲乙丙');
    expectSeated(truncated);
    expect(truncated.name).toBe('一二三四五六七八九十甲乙'); // 12 code points

    const third = await connect(rig);
    const emoji = await joinRoom(third.client, code, '🐺'.repeat(13));
    expectSeated(emoji);
    // Counted in code points, not UTF-16 units: 13 emoji cap to 12 intact ones.
    expect(emoji.name).toBe('🐺'.repeat(12));
  }, 10_000);

  it('coerces malformed and legacy-arity payloads to no name — never a hang', async () => {
    const rig = await freshRig();
    const { client: creator } = await connect(rig);
    const created = await createRoom(creator);
    const code = created.roomCode;

    // A non-string name joins nameless.
    const numeric = await joinRaw((await connect(rig)).client, code, 42);
    expect(numeric.name).toBe('');
    expect(numeric.seat).toBe(2);

    // Whitespace-only is empty after the trim — the label fallback.
    const blank = await joinRaw((await connect(rig)).client, code, '   ');
    expect(blank.name).toBe('');
    expect(blank.seat).toBe(3);

    // Pre-name client arity, (code, ack): the ack is still answered — a stale
    // tab keeps joining across a server upgrade.
    const legacy = await joinRaw((await connect(rig)).client, code);
    expect(legacy.name).toBe('');
    expect(legacy.seat).toBe(4);
  }, 10_000);

  it('persists names across a server restart', async () => {
    const dbPath = resolve(tmpdir(), `werewolf-names-${randomUUID()}.db`);
    try {
      const first = await startServer(scriptTimers(), { dbPath });
      let created: Awaited<ReturnType<typeof createRoom>>;
      try {
        const { client: creator } = await connect(first);
        created = await createRoom(creator, undefined, '阿明');
      } finally {
        await stopServer(first);
      }

      const second = await startServer(scriptTimers(), { dbPath });
      rigs.push(second);
      const revived = await connect(second);
      const ack = await rejoinRoom(revived.client, created.roomCode, created.sessionToken);
      expect(ack).toMatchObject({ seat: 1, name: '阿明' });
      await waitFor(() => revived.rec.latest?.you.seat === 1);
      expect(revived.rec.latest?.players.find((r) => r.seat === 1)?.name).toBe('阿明');
    } finally {
      await rm(dbPath, { force: true });
    }
  }, 15_000);
});
