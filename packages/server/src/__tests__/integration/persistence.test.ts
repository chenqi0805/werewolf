import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Seat } from '@werewolf/engine';
import Database from 'better-sqlite3';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import type { CreateAck } from '../../index';
import {
  connect as connectRig,
  createRoom,
  joinRoom,
  playScriptedGame,
  rejoinRoom,
  record,
  scriptTimers,
  sleep,
  startRoom,
  startServer,
  stopServer,
  waitFor,
  type Client,
  type Recorder,
  type Rig,
} from './helpers';

/**
 * Persistence: rooms, seat tokens, speech log, per-seat votes, and the
 * running clock must survive process restarts — graceful AND SIGKILL. The
 * record is the action stream; every assertion here runs through real
 * socket clients against a restarted createApp, exactly like the spec's
 * acceptance bar.
 */

/**
 * Compact clocks with one long window: the exile vote. The drive parks
 * inside it with one ballot withheld — a stable point whose remaining clock
 * the restart has to carry across.
 */
function stableTimers(): Record<string, number> {
  return { ...scriptTimers(), 'exile-vote': 8000 };
}

interface Session {
  client: Client;
  rec: Recorder;
  seat: Seat;
  token: string;
}

async function connectTo(port: number): Promise<{ client: Client; rec: Recorder }> {
  const client: Client = await new Promise((res, rej) => {
    const c: Client = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    c.once('connect', () => res(c));
    c.once('connect_error', (err: Error) => rej(err));
  });
  return { client, rec: record(client) };
}

/** Fills a table: first socket creates (seat 1), the rest join in order. */
async function openTable(
  target: number | Rig,
  seats: number,
): Promise<{ code: string; sessions: Session[] }> {
  const rig = typeof target === 'number' ? null : target;
  const port = typeof target === 'number' ? target : target.port;
  const sessions: Session[] = [];
  const first = rig ? await connectRig(rig) : await connectTo(port);
  const created: CreateAck = await createRoom(first.client);
  sessions.push({ ...first, seat: created.seat, token: created.sessionToken });
  for (let i = 1; i < seats; i++) {
    const next = rig ? await connectRig(rig) : await connectTo(port);
    const ack = await joinRoom(next.client, created.roomCode);
    if (!('sessionToken' in ack)) throw new Error('expected a seated join ack');
    sessions.push({ ...next, seat: ack.seat, token: ack.sessionToken });
  }
  return { code: created.roomCode, sessions };
}

/** Reattaches every session with its original token on a fresh server. */
async function rejoinAll(port: number, code: string, sessions: Session[]): Promise<Session[]> {
  const out: Session[] = [];
  for (const s of sessions) {
    const next = await connectTo(port);
    const ack = await rejoinRoom(next.client, code, s.token);
    expect(ack.seat, 'token must reattach to the same seat after restore').toBe(s.seat);
    out.push({ ...next, seat: ack.seat, token: s.token });
  }
  return out;
}

/**
 * waitFor with a diagnostic tail: a timeout dumps the seat's last view and
 * any game errors, so a stalled phase names itself instead of failing bare.
 */
async function waitView(
  session: Session,
  what: string,
  pred: (v: PlayerView) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (session.rec.latest !== null && !pred(session.rec.latest)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting ${what}; last view: ${JSON.stringify({
          phase: session.rec.latest.phase,
          dayNumber: session.rec.latest.dayNumber,
          step: session.rec.latest.step,
          timer: session.rec.latest.timer,
        })} errors: ${JSON.stringify(session.rec.errors)}`,
      );
    }
    await sleep(10);
  }
}
async function driveToStableWindow(sessions: Session[]): Promise<void> {
  const host = sessions[0];
  await waitFor(
    () =>
      host.rec.latest?.step.kind === 'speech' &&
      host.rec.latest.step.order?.[host.rec.latest.step.cursor] === host.seat,
  );
  host.client.emit('game:action', {
    type: 'SPEAK',
    actor: host.seat,
    text: 'a speech that must survive the restart',
  });
  await waitFor(() => sessions.every((s) => s.rec.latest?.step.kind === 'exile-vote'));
  for (const s of sessions.slice(0, -1)) {
    const view = s.rec.latest!;
    const alive = view.players.filter((p) => p.alive).map((p) => p.seat);
    s.client.emit('game:action', {
      type: 'EXILE_VOTE',
      actor: s.seat,
      target: alive.find((x) => x !== s.seat) ?? s.seat,
    });
  }
  await sleep(120); // settle: the ballots land, the withheld twelfth holds the window
  const step = host.rec.latest?.step;
  if (!(step?.kind === 'exile-vote')) {
    throw new Error(`vote window closed early: ${JSON.stringify(step)}`);
  }
}

describe('persistence — SQLite event store', () => {
  const children: ChildProcess[] = [];
  let dbPath = '';

  /** Detached spawns lead their own process groups — kill the whole tree. */
  const killTree = (child: ChildProcess): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // the group is already gone — that is exactly what we wanted
    }
  };

  afterEach(async () => {
    for (const child of children.splice(0)) killTree(child);
    await Promise.all(
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((f) => rm(f, { force: true })),
    );
  });

  afterAll(() => {
    for (const child of children.splice(0)) killTree(child);
  });

  it('restores a mid-game room across a graceful restart — tokens, backlog, votes, clock', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);
    const rig = await startServer(stableTimers(), { dbPath });
    const { code, sessions } = await openTable(rig, 12);
    await startRoom(sessions[0].client);
    await driveToStableWindow(sessions);

    // The disk record is the full action stream with provenance: player
    // actions, server actions (START_GAME), and timer-injected defaults.
    const audit = new Database(dbPath, { readonly: true });
    const sources = new Set(
      (
        audit.prepare('SELECT DISTINCT source FROM room_actions WHERE code = ?').all(code) as {
          source: string;
        }[]
      ).map((r) => r.source),
    );
    audit.close();
    expect([...sources].sort()).toEqual(['player', 'server', 'timer']);

    const before = sessions.map((s) => JSON.stringify(s.rec.latest));
    await stopServer(rig);

    const rig2 = await startServer(stableTimers(), { dbPath });
    expect(rig2.app.registry.get(code), 'room restored under its join code').toBeDefined();

    // Every original token reattaches to its original seat.
    const restored = await rejoinAll(rig2.port, code, sessions);
    await waitFor(() => restored.every((s) => s.rec.latest !== null));

    // Identical backlog: a rejoining (late) client after restore sees exactly
    // what a never-restarted client saw — including the re-armed clock.
    const after = restored.map((s) => JSON.stringify(s.rec.latest));
    expect(after).toEqual(before);

    // The restored room still plays: the vote resolves, night 2 passes,
    // day 2 arrives.
    await waitView(
      restored[0],
      'day-2 speech after restore',
      (v) => v.dayNumber >= 2 && v.step.kind === 'speech',
      20_000,
    );

    // A post-restore action is recorded too — from a LIVING seat: the
    // pre-restart ballots exiled seat 1, so its slot never returns.
    const speaker =
      restored.find((s) => s.rec.latest?.players.find((p) => p.seat === s.seat)?.alive === true) ??
      restored[1];
    await waitView(
      speaker,
      'the living speaker speech slot',
      (v) => v.step.kind === 'speech' && v.step.order?.[v.step.cursor] === speaker.seat,
    );
    speaker.client.emit('game:action', {
      type: 'SPEAK',
      actor: speaker.seat,
      text: 'speech after restore',
    });
    await sleep(50);
    const audit2 = new Database(dbPath, { readonly: true });
    const rows = audit2
      .prepare('SELECT action FROM room_actions WHERE code = ? ORDER BY seq')
      .all(code) as { action: string }[];
    audit2.close();
    expect(
      rows.some((r) => r.action.includes('speech after restore')),
      'post-restore speech recorded in the action stream',
    ).toBe(true);
    await stopServer(rig2);
  }, 40_000);

  it('restores rooms after a SIGKILL of the real server process', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);
    const repoRoot = resolve(__dirname, '../../../../..');
    const tsx = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
    const env = {
      ...process.env,
      WEREWOLF_PORT: '0',
      WEREWOLF_DB_PATH: dbPath,
      WEREWOLF_TIMERS: JSON.stringify(stableTimers()),
    };
    const boot = async (): Promise<{ child: ChildProcess; port: number }> => {
      // detached + its own process group: tsx forks a grandchild, so the
      // kill below must take down the whole tree, not just the CLI wrapper.
      const child = spawn(
        process.execPath,
        [tsx, resolve(repoRoot, 'packages/server/src/start.ts')],
        { env, cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
      children.push(child);
      let stderrTail = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000);
      });
      const port = await new Promise<number>((res, rej) => {
        let out = '';
        child.stdout?.on('data', (d: Buffer) => {
          out += d.toString();
          const m = out.match(/listening on :(\d+)/);
          if (m) res(Number(m[1]));
        });
        child.once('exit', (c) =>
          rej(new Error(`server exited early (${c}):\nstdout:\n${out}\nstderr:\n${stderrTail}`)),
        );
        setTimeout(
          () => rej(new Error(`no listen line within 15s:\n${out}\n${stderrTail}`)),
          15_000,
        );
      });
      return { child, port };
    };

    const first = await boot();
    const { code, sessions } = await openTable(first.port, 12);
    await startRoom(sessions[0].client);
    await driveToStableWindow(sessions);
    const before = sessions.map((s) => JSON.stringify(s.rec.latest));

    // The hard kill: no graceful close, no store checkpoint — WAL frames on
    // disk are the only record. The group kill takes tsx's grandchild too.
    killTree(first.child);
    await new Promise<void>((res) => first.child.once('exit', () => res()));

    const second = await boot();
    const restored = await rejoinAll(second.port, code, sessions);
    await waitFor(() => restored.every((s) => s.rec.latest !== null));
    expect(restored.map((s) => JSON.stringify(s.rec.latest))).toEqual(before);
  }, 60_000);

  it('never mints a restored room code again', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);
    const rig = await startServer(scriptTimers(), { dbPath });
    const c = await connectTo(rig.port);
    const created = await createRoom(c.client);
    await stopServer(rig);

    const rig2 = await startServer(scriptTimers(), { dbPath });
    expect(rig2.app.registry.get(created.roomCode)).toBeDefined();
    const c2 = await connectTo(rig2.port);
    const codes = new Set<string>();
    for (let i = 0; i < 300; i++) codes.add((await createRoom(c2.client)).roomCode);
    expect(codes.has(created.roomCode), 'restored code reserved from the mint set').toBe(false);
    await stopServer(rig2);
  }, 20_000);

  it('quarantines corrupt rows and still restores the healthy rooms', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);
    const rig = await startServer(scriptTimers(), { dbPath });

    // Room A: two seats, its assignments cell will be corrupted JSON.
    const a = await openTable(rig, 2);
    // Room B: a started room, its single recorded action will be corrupted.
    const bSessions: { client: Client; rec: Recorder }[] = [];
    for (let i = 0; i < 12; i++) bSessions.push(await connectTo(rig.port));
    const b = await createRoom(bSessions[0].client);
    for (let i = 1; i < 12; i++) await joinRoom(bSessions[i].client, b.roomCode);
    await startRoom(bSessions[0].client);
    // Room C: clean two-seat lobby room.
    const c = await openTable(rig, 2);
    await stopServer(rig);

    const db = new Database(dbPath);
    db.prepare(`UPDATE rooms SET assignments = '{"seat":' WHERE code = ?`).run(a.code);
    db.prepare(`UPDATE room_actions SET action = 'not-json' WHERE code = ? AND seq = 1`).run(
      b.roomCode,
    );
    db.close();

    // The boot itself must survive both corruptions.
    const rig2 = await startServer(scriptTimers(), { dbPath });
    expect(rig2.app.registry.get(c.code), 'healthy room restored').toBeDefined();
    expect(rig2.app.registry.get(a.code), 'corrupt-assignments room quarantined').toBeUndefined();
    expect(rig2.app.registry.get(b.roomCode), 'corrupt-action room quarantined').toBeUndefined();

    // Quarantine marks are durable, and the bad codes are reserved.
    const audit = new Database(dbPath, { readonly: true });
    const marks = audit.prepare('SELECT code, quarantined_at FROM rooms').all() as {
      code: string;
      quarantined_at: number | null;
    }[];
    audit.close();
    for (const bad of [a.code, b.roomCode]) {
      expect(marks.find((m) => m.code === bad)?.quarantined_at).not.toBeNull();
    }
    const fresh = await connectTo(rig2.port);
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add((await createRoom(fresh.client)).roomCode);
    for (const bad of [a.code, b.roomCode]) {
      expect(codes.has(bad), 'quarantined code never minted').toBe(false);
    }
    await stopServer(rig2);
  }, 20_000);

  it('restores lobby rooms and finished games with their full history', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);

    // Leg 1: a lobby room, two seats, never started.
    const rigA = await startServer(scriptTimers(), { dbPath });
    const lobby = await openTable(rigA, 2);
    await stopServer(rigA);

    // Leg 2: a full scripted game played to a winner in a second room.
    const rigB = await startServer(scriptTimers(), { dbPath });
    const finished = await openTable(rigB, 12);
    await startRoom(finished.sessions[0].client);
    await playScriptedGame(rigB);
    const finalViews = finished.sessions.map((s) => s.rec.latest!);
    expect(finalViews.every((v) => v.phase === 'game-over' && v.winner !== null)).toBe(true);
    await stopServer(rigB);

    // Leg 3: both come back — the lobby still in lobby, the finished game
    // byte-identical down to its full event backlog.
    const rigC = await startServer(scriptTimers(), { dbPath });
    expect(rigC.app.registry.get(lobby.code)).toBeDefined();
    expect(rigC.app.registry.get(finished.code)).toBeDefined();
    const lobbyBack = await rejoinAll(rigC.port, lobby.code, lobby.sessions);
    await waitFor(() => lobbyBack.every((s) => s.rec.latest !== null));
    expect(lobbyBack.every((s) => s.rec.latest!.phase === 'lobby')).toBe(true);
    const gameBack = await rejoinAll(rigC.port, finished.code, finished.sessions);
    await waitFor(() => gameBack.every((s) => s.rec.latest !== null));
    expect(gameBack.map((s) => JSON.stringify(s.rec.latest))).toEqual(
      finalViews.map((v) => JSON.stringify(v)),
    );
    await stopServer(rigC);
  }, 90_000);
});
