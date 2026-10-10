import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Seat } from '@werewolf/engine';
import { campOf } from '@werewolf/engine';
import Database from 'better-sqlite3';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import type { CreateAck, PlayerView } from '../../index';
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

/** First element or throw — indexed access under noUncheckedIndexedAccess. */
function firstOf<T>(xs: T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error('expected a non-empty list');
  return x;
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
  const host = firstOf(sessions);
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

/**
 * Explode/election scenario clocks: the windows the driver acts in — or
 * restarts inside — get seconds of headroom (a restart cycle costs 1–2s),
 * everything else stays at the script floor so interrupts, announcements,
 * and lapsed speech slots self-resolve.
 */
function electionTimers(): Record<string, number> {
  return {
    ...scriptTimers(),
    'night:wolf': 8000,
    'night:witch': 8000,
    'night:seer': 8000,
    'sheriff-signup': 8000,
    'sheriff-speech': 2500,
    'sheriff-vote': 8000,
    speech: 8000,
    'badge-pass': 8000,
  };
}

/** The room's living wolf-camp seats, read from each seat's own view. */
function livingWolfSeats(sessions: Session[]): Seat[] {
  const wolves: Seat[] = [];
  for (const s of sessions) {
    const you = s.rec.latest?.you;
    if (you === undefined || !you.alive || you.role === null) continue;
    if (campOf(you.role) === 'wolf') wolves.push(s.seat);
  }
  return wolves.sort((a, b) => a - b);
}

/**
 * Waits until every seat's own view satisfies pred. Role reads across the
 * table (livingWolfSeats) are only safe once every socket has caught up —
 * the host's view alone can lead the others by whole phases.
 */
async function waitAllViews(
  sessions: Session[],
  what: string,
  pred: (v: PlayerView) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  await Promise.all(sessions.map((s) => waitView(s, what, pred, timeoutMs)));
}

/**
 * Drives night 1 by hand: the pack knives the lowest non-wolf seat, the
 * witch and the seer pass. Leaves the room inside the day-1 signup window
 * with the kill buffered — unannounced, per the day-1 gating.
 */
async function driveNightOne(sessions: Session[]): Promise<Seat> {
  await waitAllViews(
    sessions,
    'the night-1 wolf step on every seat',
    (v) => v.phase === 'night' && v.step.kind === 'night' && v.step.step === 'wolf',
  );
  const wolves = livingWolfSeats(sessions);
  const host = firstOf(sessions);
  const alive = (host.rec.latest?.players ?? []).filter((p) => p.alive).map((p) => p.seat);
  const prey = alive.find((s) => !wolves.includes(s));
  if (prey === undefined) throw new Error('no non-wolf seat to knife');
  for (const s of sessions) {
    if (!wolves.includes(s.seat)) continue;
    s.client.emit('game:action', { type: 'WOLF_KILL', actor: s.seat, target: prey });
  }
  await waitView(host, 'the witch step', (v) => v.step.kind === 'night' && v.step.step === 'witch');
  const witch = sessions.find((s) => {
    const you = s.rec.latest?.you;
    return you !== undefined && you.alive && you.role === 'witch';
  });
  if (witch) witch.client.emit('game:action', { type: 'WITCH_PASS', actor: witch.seat });
  await waitView(host, 'the seer step', (v) => v.step.kind === 'night' && v.step.step === 'seer');
  const seer = sessions.find((s) => {
    const you = s.rec.latest?.you;
    return you !== undefined && you.alive && you.role === 'seer';
  });
  if (seer) seer.client.emit('game:action', { type: 'SEER_PASS', actor: seer.seat });
  await waitView(
    host,
    'the day-1 signup with the kill buffered',
    (v) => v.phase === 'sheriff-signup',
  );
  return prey;
}

/** The recorded action stream for a room: one JSON row per applied action. */
function actionRows(dbPath: string, code: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare('SELECT action FROM room_actions WHERE code = ? ORDER BY seq').all(code) as {
        action: string;
      }[]
    ).map((r) => r.action);
  } finally {
    db.close();
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
    await startRoom(firstOf(sessions).client);
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
      firstOf(restored),
      'day-2 speech after restore',
      (v) => v.dayNumber >= 2 && v.step.kind === 'speech',
      20_000,
    );

    // A post-restore action is recorded too — from a LIVING seat: the
    // pre-restart ballots exiled seat 1, so its slot never returns.
    const speaker =
      restored.find((s) => s.rec.latest?.players.find((p) => p.seat === s.seat)?.alive === true) ??
      firstOf(restored);
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
    await startRoom(firstOf(sessions).client);
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
    const b = await createRoom(firstOf(bSessions).client);
    for (const s of bSessions.slice(1)) await joinRoom(s.client, b.roomCode);
    await startRoom(firstOf(bSessions).client);
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
    await startRoom(firstOf(finished.sessions).client);
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

  it('replays an action log containing WOLF_EXPLODE byte-identical', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);
    const rig = await startServer(electionTimers(), { dbPath });
    const { code, sessions } = await openTable(rig, 12);
    await startRoom(firstOf(sessions).client);
    const prey = await driveNightOne(sessions);
    const host = firstOf(sessions);

    // A living plain wolf blows up the day-1 election: the platform voids,
    // the buffered kill releases through the dawn announcements, night falls.
    const wolves = livingWolfSeats(sessions);
    const wolf = sessions.find((s) => wolves.includes(s.seat));
    if (!wolf) throw new Error('no wolf session');
    wolf.client.emit('game:action', { type: 'WOLF_EXPLODE', actor: wolf.seat });
    await waitView(
      host,
      'night-2 after the explode release',
      (v) => v.phase === 'night' && v.dayNumber === 2,
      15_000,
    );
    await sleep(150); // settle trailing broadcasts before the snapshot

    // Ordering pinned at the view log: the explode is public, the buffered
    // kill announced after it, and night began with no speech program.
    const log = host.rec.latest?.log ?? [];
    expect(log.findIndex((e) => e.type === 'WOLF_EXPLODED')).toBeGreaterThanOrEqual(0);
    expect(
      log.findIndex((e) => e.type === 'DEATH_ANNOUNCED'),
      'the buffered kill released after the explode',
    ).toBeGreaterThan(log.findIndex((e) => e.type === 'WOLF_EXPLODED'));
    expect(
      log.findIndex((e) => e.type === 'NIGHT_BEGAN' && e.dayNumber === 2),
      'night fell after the release, day program skipped',
    ).toBeGreaterThan(log.findIndex((e) => e.type === 'DEATH_ANNOUNCED'));
    // The exploder's death is public through WOLF_EXPLODED — the only
    // DEATH_ANNOUNCED row is the buffered night kill.
    expect(log.filter((e) => e.type === 'DEATH_ANNOUNCED').map((e) => e.seat)).toEqual([prey]);

    const before = sessions.map((s) => JSON.stringify(s.rec.latest));
    const rowsBefore = actionRows(dbPath, code);
    expect(
      rowsBefore.some((r) => r.includes('"WOLF_EXPLODE"')),
      'the explode is in the recorded stream',
    ).toBe(true);
    await stopServer(rig);

    const rig2 = await startServer(electionTimers(), { dbPath });
    expect(rig2.app.registry.get(code), 'room restored under its join code').toBeDefined();
    const restored = await rejoinAll(rig2.port, code, sessions);
    await waitFor(() => restored.every((s) => s.rec.latest !== null));
    expect(restored.map((s) => JSON.stringify(s.rec.latest))).toEqual(before);

    // Zero schema change: the new action rides the same append-only table,
    // and the restored room only ever appends to the recorded stream.
    const rowsAfter = actionRows(dbPath, code);
    expect(rowsAfter.slice(0, rowsBefore.length)).toEqual(rowsBefore);
    await stopServer(rig2);
  }, 30_000);

  it('restores a mid-election room with ballots half-cast and deaths still buffered', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);
    const rig = await startServer(electionTimers(), { dbPath });
    const { code, sessions } = await openTable(rig, 12);
    await startRoom(firstOf(sessions).client);
    const prey = await driveNightOne(sessions);
    const host = firstOf(sessions);

    // The lowest living non-wolf seat runs; the signup and speech windows
    // lapse into the ballot.
    const wolves = livingWolfSeats(sessions);
    const candidate = sessions.find((s) => {
      const you = s.rec.latest?.you;
      return s.seat !== prey && !wolves.includes(s.seat) && you?.alive === true;
    });
    if (!candidate) throw new Error('no non-wolf candidate seat');
    candidate.client.emit('game:action', { type: 'SHERIFF_SIGNUP', actor: candidate.seat });
    await waitView(host, 'the sheriff ballot', (v) => v.step.kind === 'sheriff-vote', 20_000);
    const vote = host.rec.latest?.step;
    if (!(vote?.kind === 'sheriff-vote')) throw new Error('no sheriff vote view');

    // Ten of the eleven ballots cast before the restart; the last seat
    // withholds so the restored room has live vote state to carry across.
    const voters = vote.electorate.slice(0, -1);
    for (const s of sessions) {
      if (!voters.includes(s.seat)) continue;
      s.client.emit('game:action', { type: 'SHERIFF_VOTE', actor: s.seat, target: candidate.seat });
    }
    await sleep(150); // settle: the ten ballots land, the withheld seat holds the window
    expect(
      host.rec.events.some((e) => e.type === 'DEATH_ANNOUNCED'),
      'deaths stay buffered through the election',
    ).toBe(false);

    const before = sessions.map((s) => JSON.stringify(s.rec.latest));
    await stopServer(rig);

    const rig2 = await startServer(electionTimers(), { dbPath });
    expect(rig2.app.registry.get(code)).toBeDefined();
    const restored = await rejoinAll(rig2.port, code, sessions);
    await waitFor(() => restored.every((s) => s.rec.latest !== null));
    expect(restored.map((s) => JSON.stringify(s.rec.latest))).toEqual(before);

    // The restored room finishes the election: the withheld ballot lapses
    // into an abstention, the ten cast ballots elect the candidate, and only
    // then does the buffered kill announce. Had the ballots not survived the
    // replay, the lapse would void the election instead.
    const rhost = firstOf(restored);
    await waitView(rhost, 'day-1 speech after the election', (v) => v.phase === 'speech', 20_000);
    expect(
      rhost.rec.events.findIndex((e) => e.type === 'DEATH_ANNOUNCED'),
      'the kill announced only after the election resolved',
    ).toBeGreaterThan(rhost.rec.events.findIndex((e) => e.type === 'SHERIFF_ELECTED'));
    expect(rhost.rec.events.filter((e) => e.type === 'SHERIFF_ELECTED').map((e) => e.seat)).toEqual(
      [candidate.seat],
    );
    expect(rhost.rec.events.filter((e) => e.type === 'DEATH_ANNOUNCED').map((e) => e.seat)).toEqual(
      [prey],
    );
    await stopServer(rig2);
  }, 40_000);

  it('restores mid-explode-settlement — the badge window resolves before night', async () => {
    dbPath = resolve(tmpdir(), `werewolf-persist-${randomUUID()}.db`);
    const rig = await startServer(electionTimers(), { dbPath });
    const { code, sessions } = await openTable(rig, 12);
    await startRoom(firstOf(sessions).client);
    await driveNightOne(sessions);
    const host = firstOf(sessions);

    // The lowest living wolf runs for sheriff: signs up, speaks his slot,
    // and every 警下 ballot lands on him.
    const wolves = livingWolfSeats(sessions);
    const wolfSession = sessions.find((s) => wolves.includes(s.seat));
    if (!wolfSession) throw new Error('no wolf session');
    wolfSession.client.emit('game:action', { type: 'SHERIFF_SIGNUP', actor: wolfSession.seat });
    await waitView(
      host,
      "the candidate's speech slot",
      (v) => v.step.kind === 'sheriff-speech' && v.step.queue[v.step.cursor] === wolfSession.seat,
      20_000,
    );
    wolfSession.client.emit('game:action', {
      type: 'SPEAK',
      actor: wolfSession.seat,
      text: '警上发言',
    });
    await waitView(host, 'the sheriff ballot', (v) => v.step.kind === 'sheriff-vote', 20_000);
    const ballot = host.rec.latest?.step;
    if (!(ballot?.kind === 'sheriff-vote')) throw new Error('no sheriff vote view');
    for (const s of sessions) {
      if (!ballot.electorate.includes(s.seat)) continue;
      s.client.emit('game:action', {
        type: 'SHERIFF_VOTE',
        actor: s.seat,
        target: wolfSession.seat,
      });
    }
    await waitView(host, 'the day-1 speech', (v) => v.phase === 'speech', 20_000);

    // The badge holder sets the direction, then blows up the day: his badge
    // window opens — the settlement pauses mid-flight for the restart.
    const sheriff = sessions.find((s) => s.rec.latest?.you.hasBadge === true);
    if (!sheriff) throw new Error('no badge holder session');
    expect(sheriff.seat).toBe(wolfSession.seat);
    sheriff.client.emit('game:action', {
      type: 'SET_SPEECH_DIRECTION',
      actor: sheriff.seat,
      direction: 'cw',
    });
    sheriff.client.emit('game:action', { type: 'WOLF_EXPLODE', actor: sheriff.seat });
    await waitView(host, "the sheriff's badge window", (v) => v.step.kind === 'badge-pass', 15_000);
    const badgeStep = host.rec.latest?.step;
    if (!(badgeStep?.kind === 'badge-pass')) throw new Error('no badge-pass view');
    expect(badgeStep.seat).toBe(sheriff.seat);
    await sleep(150); // settle trailing broadcasts before the snapshot

    const before = sessions.map((s) => JSON.stringify(s.rec.latest));
    const rowsBefore = actionRows(dbPath, code);
    expect(rowsBefore.some((r) => r.includes('"WOLF_EXPLODE"'))).toBe(true);
    await stopServer(rig);

    const rig2 = await startServer(electionTimers(), { dbPath });
    expect(rig2.app.registry.get(code)).toBeDefined();
    const restored = await rejoinAll(rig2.port, code, sessions);
    await waitFor(() => restored.every((s) => s.rec.latest !== null));
    expect(restored.map((s) => JSON.stringify(s.rec.latest))).toEqual(before);

    // The restored badge window lapses into 撕毁 (SHERIFF_PASS target:null);
    // the settlement then drains into night — the badge resolved first.
    const rhost = firstOf(restored);
    await waitView(
      rhost,
      'night-2 after the badge resolution',
      (v) => v.phase === 'night' && v.dayNumber === 2,
      20_000,
    );
    expect(rhost.rec.events.some((e) => e.type === 'NIGHT_BEGAN')).toBe(true);
    expect(
      (rhost.rec.latest?.players ?? [])
        .filter((p) => p.seat === sheriff.seat)
        .map((p) => p.hasBadge),
    ).toEqual([false]);
    const rowsAfter = actionRows(dbPath, code);
    expect(rowsAfter.slice(0, rowsBefore.length)).toEqual(rowsBefore);
    await stopServer(rig2);
  }, 40_000);
});
