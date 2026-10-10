import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../../eventStore';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  scriptTimers,
  startRoom,
  startServer,
  stopServer,
  waitFor,
  type Client,
  type Rig,
} from './helpers';

/**
 * Gateway robustness regressions: room:create must never take the process
 * down (SRV-1/SRV-5), and a failed timer expiry must re-arm the clock
 * instead of wedging the room forever (SRV-3).
 */

const rigs: Rig[] = [];
const dbPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
  await Promise.all(
    dbPaths.flatMap((f) => [f, `${f}-wal`, `${f}-shm`].map((file) => rm(file, { force: true }))),
  );
  dbPaths.length = 0;
});

/** Raw room:create send with an untyped payload — malformed-board tests. */
function createRaw(socket: Client, payload: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    // Invoked in method position: extracting emit into a variable would lose
    // the receiver (the same cast-and-call pattern helpers.sendRaw uses).
    (socket.emit as (event: string, ...args: unknown[]) => void)(
      'room:create',
      payload,
      (resp: unknown) => resolve(resp),
    );
  });
}

describe('room:create hardening (SRV-1, SRV-5)', () => {
  it('acks INVALID_BOARD for prototype-chain board ids and keeps the server up', async () => {
    const rig = await startServer();
    rigs.push(rig);
    const { client } = await connect(rig);

    // 'toString' and 'constructor' resolve through Object.prototype — the
    // old `in` guard let them through and shuffledDeck threw on the result.
    for (const board of ['toString', 'constructor']) {
      const resp = await createRaw(client, { board });
      expect(resp).toEqual({ error: 'INVALID_BOARD' });
    }

    // The process survived both payloads: a normal create still succeeds.
    const ok = await createRoom(client);
    expect(ok.roomCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    expect(ok.seat).toBe(1);
  }, 10_000);

  it('acks an error code when the store fails during create — process survives', async () => {
    const dbPath = resolve(tmpdir(), `werewolf-gw-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const rig = await startServer(scriptTimers(), { dbPath });
    rigs.push(rig);
    const { client } = await connect(rig);

    const failingStore = vi.spyOn(EventStore.prototype, 'upsertRoom').mockImplementation(() => {
      throw new Error('disk full (simulated store failure)');
    });

    // The room row write is the first store touch of a create — the same
    // throw registry.create/room.join can produce with a failing SQLite.
    const resp = await createRaw(client, { board: 'classic' });
    expect(resp).toEqual({ error: 'INTERNAL' });

    // One socket's error, never a process exit: a normal create succeeds
    // on the same connection once the store recovers.
    failingStore.mockRestore();
    const ok = await createRoom(client);
    expect(ok.roomCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  }, 10_000);
});

describe('timer expiry survives a persistence-hook failure (SRV-3)', () => {
  it('re-arms the clock after a throwing hook and advances on the next expiry', async () => {
    const dbPath = resolve(tmpdir(), `werewolf-gw-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const rig = await startServer(scriptTimers(), { dbPath });
    rigs.push(rig);

    const realAppend = EventStore.prototype.appendAction;
    type AppendRow = Parameters<typeof realAppend>[0];
    // The hook throws exactly once, on the first timer-source append — the
    // first expiry's default action. Starts ('server') pass through.
    let threw = false;
    vi.spyOn(EventStore.prototype, 'appendAction').mockImplementation(function (
      this: EventStore,
      row: AppendRow,
    ) {
      if (!threw && row.source === 'timer') {
        threw = true;
        throw new Error('disk full (simulated store failure)');
      }
      realAppend.call(this, row);
    });

    const errorLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.map(String).join(' '));
    });

    const { client: creator, rec: creatorRec } = await connect(rig);
    const { roomCode } = await createRoom(creator);
    for (const j of await connectAll(rig, 11)) await joinRoom(j.client, roomCode);
    await startRoom(creator);

    // The night:wolf deadline the room is advertising before the failure.
    await waitFor(() => creatorRec.latest?.timer?.key === 'night:wolf');
    const stale = creatorRec.latest?.timer;
    expect(stale?.key).toBe('night:wolf');

    // The hook throws during the first expiry...
    await waitFor(() => errorLines.some((l) => l.includes('timer injection failed')), 5000);
    expect(threw).toBe(true);

    // ...but the room is not timerless: a fresh deadline is advertised...
    await waitFor(
      () => (creatorRec.latest?.timer?.endsAt ?? 0) > (stale?.endsAt ?? Infinity),
      5000,
    );

    // ...and the next expiry advances the game past the wolf window.
    await waitFor(() => creatorRec.latest?.phase === 'dawn-announce', 10_000);

    // Exactly one failure: the re-arm healed the room, it did not loop.
    expect(errorLines.filter((l) => l.includes('timer injection failed')).length).toBe(1);
  }, 20_000);
});
