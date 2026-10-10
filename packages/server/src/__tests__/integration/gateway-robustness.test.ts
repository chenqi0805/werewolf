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

describe('internal errors never leak detail to clients (F5)', () => {
  /** A store failure whose message embeds a database path — the leak F5 closes. */
  const STORE_FAILURE =
    'SQLITE_CANTOPEN: unable to open database file at /var/lib/werewolf/data/werewolf.db';

  /** Captures the server-side error log — the detail must land here, not on the wire. */
  function spyConsoleError(): string[] {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    return lines;
  }

  it('acks a store-hook failure with no filesystem or SQLite path text', async () => {
    const dbPath = resolve(tmpdir(), `werewolf-gw-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const rig = await startServer(scriptTimers(), { dbPath });
    rigs.push(rig);
    const { client } = await connect(rig);

    vi.spyOn(EventStore.prototype, 'upsertRoom').mockImplementation(() => {
      throw new Error(STORE_FAILURE);
    });
    const errorLines = spyConsoleError();

    const resp = await createRaw(client, { board: 'classic' });
    // Exact shape: the ack carries the code and nothing else — no message
    // field, no path text on the wire.
    expect(resp).toEqual({ error: 'INTERNAL' });

    // The full detail — path included — stays in the server log.
    expect(errorLines.some((l) => l.includes(STORE_FAILURE))).toBe(true);
  }, 10_000);

  it('reduces an unexpected throw on a legal game action to the generic game:error payload', async () => {
    const dbPath = resolve(tmpdir(), `werewolf-gw-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    // Hold the night:wolf step open so no expiry can race the action.
    const rig = await startServer({ ...scriptTimers(), 'night:wolf': 60_000 }, { dbPath });
    rigs.push(rig);

    const { client: creator, rec: creatorRec } = await connect(rig);
    const created = await createRoom(creator);
    const seats = await connectAll(rig, 11);
    for (const s of seats) await joinRoom(s.client, created.roomCode);
    await startRoom(creator);

    // The deal is random: discover a wolf from the dealt views.
    const recs = [creatorRec, ...seats.map((s) => s.rec)];
    await waitFor(() => recs.every((r) => r.latest?.you.role));
    const wolfRec = recs.find((r) => r.latest?.you.role === 'werewolf');
    const wolfView = wolfRec?.latest;
    if (!wolfRec || !wolfView?.you.seat || !wolfView.you.wolfPack) {
      throw new Error('no wolf dealt on the standard board');
    }
    const pack = new Set(wolfView.you.wolfPack);
    const target = wolfView.players.find((p) => p.alive && !pack.has(p.seat))?.seat;
    if (target === undefined) throw new Error('no living non-wolf target');

    // The hook throws only on player-source appends: starts and timer
    // injections pass through, so no clock can race the assertion.
    const realAppend = EventStore.prototype.appendAction;
    type AppendRow = Parameters<typeof realAppend>[0];
    vi.spyOn(EventStore.prototype, 'appendAction').mockImplementation(function (
      this: EventStore,
      row: AppendRow,
    ) {
      if (row.source === 'player') throw new Error(STORE_FAILURE);
      realAppend.call(this, row);
    });
    const errorLines = spyConsoleError();

    // A legal wolf vote reaches the hook and fails there — past the engine,
    // exactly the path that echoed the raw message before the fix.
    const wolfClient = wolfRec === creatorRec ? creator : seats[recs.indexOf(wolfRec) - 1].client;
    wolfClient.emit('game:action', { type: 'WOLF_KILL', actor: wolfView.you.seat, target });
    await waitFor(() => wolfRec.errors.length > 0);

    // The full payload is the generic one — no engine text, no path text.
    expect(wolfRec.errors).toEqual([{ code: 'INTERNAL', message: 'Internal error' }]);
    expect(errorLines.some((l) => l.includes(STORE_FAILURE))).toBe(true);
  }, 10_000);

  it('passes domain errors through with their real code and message', async () => {
    const rig = await startServer(scriptTimers());
    rigs.push(rig);
    const { client, rec } = await connect(rig);
    await createRoom(client);

    // An exile vote in the lobby is a stable engine rejection — its curated
    // code and message must survive errorPayload untouched.
    client.emit('game:action', { type: 'EXILE_VOTE', actor: 1, target: 2 });
    await waitFor(() => rec.errors.length > 0);
    expect(rec.errors[0]).toEqual({
      code: 'WRONG_PHASE',
      message: 'No exile vote is in progress.',
    });
  }, 10_000);
});
