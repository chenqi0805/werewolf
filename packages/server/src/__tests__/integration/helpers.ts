import type { AddressInfo } from 'node:net';
import type { GameEvent, PlayerAction, Seat } from '@werewolf/engine';
import {
  createApp,
  type AppHandle,
  type CreateAck,
  type ErrorPayload,
  type JoinAck,
  type OkAck,
  type PlayerView,
  type RejoinAck,
  type ServerToClientEvents,
  type ClientToServerEvents,
} from '../../index';
import { expect } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { VoiceChunk } from '../../voice';

export type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface Recorder {
  views: PlayerView[];
  events: GameEvent[];
  errors: ErrorPayload[];
  voiceChunks: VoiceChunk[];
  /** Assistant acks and other ask/response results, for the leak sweep. */
  acks: unknown[];
  latest: PlayerView | null;
}

export interface Rig {
  app: AppHandle;
  port: number;
  clients: Client[];
  recs: Recorder[];
}

/** Uniform short clocks — every phase auto-defaults in tens of ms. */
export function scriptTimers(): Record<string, number> {
  const keys = [
    'night:wolf',
    'night:witch',
    'night:seer',
    'sheriff-signup',
    'sheriff-speech',
    'sheriff-vote',
    'dawn-announce',
    'last-words',
    'speech',
    'exile-vote',
    'pk-speech',
    'pk-vote',
    'hunter-shot',
    'badge-pass',
  ];
  return Object.fromEntries(keys.map((k) => [k, 40]));
}

export async function startServer(
  timers: Record<string, number> = scriptTimers(),
  extra: Partial<Parameters<typeof createApp>[0]> = {},
): Promise<Rig> {
  const app = createApp({ timers, ...extra });
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  const port = (app.httpServer.address() as AddressInfo).port;
  return { app, port, clients: [], recs: [] };
}

export async function stopServer(rig: Rig): Promise<void> {
  for (const c of rig.clients) c.disconnect();
  rig.clients.length = 0;
  rig.recs.length = 0;
  await rig.app.close();
}

export function record(socket: Client): Recorder {
  const rec: Recorder = {
    views: [],
    events: [],
    errors: [],
    voiceChunks: [],
    acks: [],
    latest: null,
  };
  socket.on('game:view', (view) => {
    rec.views.push(view);
    rec.latest = view;
  });
  socket.on('game:event', (event) => rec.events.push(event));
  socket.on('game:error', (error) => rec.errors.push(error));
  socket.on('voice:chunk', (chunk) => rec.voiceChunks.push(chunk));
  return rec;
}

export interface Connected {
  client: Client;
  rec: Recorder;
}

/** Connects a client and hands back its recorder pair — no index math. */
export async function connect(rig: Rig): Promise<Connected> {
  const socket: Client = await new Promise((resolve, reject) => {
    const s: Client = io(`http://127.0.0.1:${rig.port}`, { transports: ['websocket'] });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err: Error) => reject(err));
  });
  const rec = record(socket);
  rig.clients.push(socket);
  rig.recs.push(rec);
  return { client: socket, rec };
}

export async function connectAll(rig: Rig, n: number): Promise<Connected[]> {
  const out: Connected[] = [];
  for (let i = 0; i < n; i++) out.push(await connect(rig));
  return out;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

export async function createRoom(socket: Client): Promise<CreateAck> {
  return new Promise((resolve, reject) => {
    socket.emit('room:create', (resp) => {
      if ('error' in resp) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
}

export async function joinRoom(socket: Client, code: string): Promise<JoinAck> {
  return new Promise((resolve, reject) => {
    socket.emit('room:join', code, (resp) => {
      if ('error' in resp) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
}

export async function rejoinRoom(socket: Client, code: string, token: string): Promise<RejoinAck> {
  return new Promise((resolve, reject) => {
    socket.emit('room:rejoin', code, token, (resp) => {
      if ('error' in resp) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
}

export async function startRoom(socket: Client): Promise<OkAck> {
  return new Promise((resolve, reject) => {
    socket.emit('room:start', (resp) => {
      if ('error' in resp) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
}

export async function leaveRoom(socket: Client): Promise<OkAck> {
  return new Promise((resolve, reject) => {
    socket.emit('room:leave', (resp) => {
      if ('error' in resp) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
}

/** Deliberately untyped send for malformed-payload tests. */
export function sendRaw(socket: Client, payload: unknown): void {
  (socket.emit as (event: string, ...args: unknown[]) => void)('game:action', payload);
}

/**
 * View-driven bot: every decision comes from the actor's own fog-of-war
 * view — exactly what a real client (or a phase-two AI) sees. Actions are
 * deduped per phase slot so view updates do not double-send.
 */
export async function playScriptedGame(rig: Rig, timeoutMs = 30_000): Promise<void> {
  const sent = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error('scripted game did not finish in time');
    // Only connected clients are driven and only their views gate completion —
    // a vanished player's rec must never stall the script.
    const active: PlayerView[] = [];
    for (let i = 0; i < rig.clients.length; i++) {
      const client = rig.clients[i];
      if (!client || !client.connected) continue;
      const view = rig.recs[i]?.latest;
      if (view) active.push(view);
    }
    if (active.length > 0 && active.every((v) => v.phase === 'game-over' && v.winner !== null)) {
      return;
    }
    for (let i = 0; i < rig.clients.length; i++) {
      const client = rig.clients[i];
      if (!client || !client.connected) continue;
      const view = rig.recs[i]?.latest;
      if (view) actOnce(client, view, sent);
    }
    await sleep(5);
  }
}

function actOnce(socket: Client, view: PlayerView, sent: Set<string>): void {
  const you = view.you;
  if (you.seat === null) return;
  const seat = you.seat;
  const alive = view.players
    .filter((r) => r.alive)
    .map((r) => r.seat)
    .sort((a, b) => a - b);
  const key = `${seat}:d${view.dayNumber}:${view.phase}`;
  const send = (action: PlayerAction) => socket.emit('game:action', action);

  if (
    view.step.kind === 'night' &&
    view.step.step === 'wolf' &&
    you.alive &&
    you.role === 'werewolf'
  ) {
    const k = `${key}:wolf`;
    if (sent.has(k)) return;
    sent.add(k);
    const pack = new Set(you.wolfPack ?? []);
    const target = alive.find((s) => !pack.has(s));
    if (target !== undefined) send({ type: 'WOLF_KILL', actor: seat, target });
    return;
  }
  if (
    view.step.kind === 'night' &&
    view.step.step === 'witch' &&
    you.alive &&
    you.role === 'witch'
  ) {
    const k = `${key}:witch`;
    if (sent.has(k)) return;
    sent.add(k);
    const kt = you.witchPotions?.killTarget ?? null;
    if (view.dayNumber === 1 && kt === seat) send({ type: 'WITCH_HEAL', actor: seat });
    send({ type: 'WITCH_PASS', actor: seat });
    return;
  }
  if (view.step.kind === 'night' && view.step.step === 'seer' && you.alive && you.role === 'seer') {
    const k = `${key}:seer`;
    if (sent.has(k)) return;
    sent.add(k);
    const checked = new Set(Object.keys(you.seerChecks ?? {}).map(Number));
    const target = alive.find((s) => s !== seat && !checked.has(s));
    if (target !== undefined) send({ type: 'SEER_CHECK', actor: seat, target });
    else send({ type: 'SEER_PASS', actor: seat });
    return;
  }
  if (view.step.kind === 'speech' && you.alive && view.step.order) {
    const slot = view.step.order[view.step.cursor];
    if (slot === seat) {
      const k = `${key}:speech:${view.step.cursor}`;
      if (sent.has(k)) return;
      sent.add(k);
      send({ type: 'SPEAK', actor: seat, text: `seat ${seat} speaks` });
    }
    return;
  }
  if (view.step.kind === 'last-words') {
    const slot = view.step.queue[view.step.cursor];
    if (slot === seat) {
      const k = `${key}:lw:${view.step.cursor}`;
      if (sent.has(k)) return;
      sent.add(k);
      send({ type: 'SPEAK', actor: seat, text: `seat ${seat} last words` });
    }
    return;
  }
  if (
    view.step.kind === 'exile-vote' &&
    you.voteWeight > 0 &&
    view.step.electorate.includes(seat)
  ) {
    const k = `${key}:vote`;
    if (sent.has(k)) return;
    sent.add(k);
    send({ type: 'EXILE_VOTE', actor: seat, target: alive.find((s) => s !== seat) ?? seat });
    return;
  }
  if (view.step.kind === 'pk-vote' && you.voteWeight > 0 && view.step.electorate.includes(seat)) {
    const k = `${key}:pvote`;
    if (sent.has(k)) return;
    sent.add(k);
    if (view.step.voteKind === 'sheriff') {
      send({ type: 'SHERIFF_VOTE', actor: seat, target: null });
    } else {
      send({ type: 'EXILE_VOTE', actor: seat, target: alive.find((s) => s !== seat) ?? seat });
    }
    return;
  }
  if (
    view.step.kind === 'sheriff-vote' &&
    you.voteWeight > 0 &&
    view.step.electorate.includes(seat)
  ) {
    const k = `${key}:svote`;
    if (sent.has(k)) return;
    sent.add(k);
    send({ type: 'SHERIFF_VOTE', actor: seat, target: null });
    return;
  }
  if (view.step.kind === 'hunter-shot' && view.step.seat === seat) {
    const k = `${key}:hunter`;
    if (sent.has(k)) return;
    sent.add(k);
    const target = alive.find((s) => s !== seat);
    if (target !== undefined) send({ type: 'HUNTER_SHOOT', actor: seat, target });
    return;
  }
  if (view.step.kind === 'badge-pass' && view.step.seat === seat) {
    const k = `${key}:badge`;
    if (sent.has(k)) return;
    sent.add(k);
    const target = alive.find((s) => s !== seat);
    if (target !== undefined) send({ type: 'SHERIFF_PASS', actor: seat, target });
    return;
  }
}

/** Server-only event types — nothing in this set may ever reach a socket. */
const SERVER_TYPES = new Set([
  'WOLF_KILL_VOTE',
  'KILL_TARGET_SET',
  'WITCH_HEALED',
  'WITCH_POISONED',
  'WITCH_PASSED',
  'SEER_PASSED',
  'DEATH_RESOLVED',
  'SPEECH_ENDED',
]);

/**
 * Sweeps every captured view and event of every client: no view may contain
 * a role that viewer is not entitled to, no private extra may leak, and no
 * server-only event may appear in any socket's stream.
 */
export function sweepAllPayloads(rig: Rig): void {
  for (let i = 0; i < rig.recs.length; i++) {
    const rec = rig.recs[i];
    if (!rec) continue;
    for (const view of rec.views) {
      const over = view.phase === 'game-over';
      const youRole = view.players.find((r) => r.seat === view.you.seat)?.role ?? null;
      const revealed = new Set<Seat>();
      for (const e of view.log) {
        if (e.type === 'IDIOT_REVEALED') revealed.add(e.seat);
        if (e.type === 'HUNTER_SHOT') revealed.add(e.shooter);
      }
      for (const row of view.players) {
        if (row.role === null) continue;
        const allowed =
          row.seat === view.you.seat ||
          over ||
          revealed.has(row.seat) ||
          (youRole === 'werewolf' && row.role === 'werewolf');
        expect(
          allowed,
          `client ${i} saw seat ${row.seat} as ${row.role} in phase ${view.phase}`,
        ).toBe(true);
      }
      if (youRole !== 'werewolf') {
        expect(view.you.wolfPack, `client ${i} received the wolf pack`).toBeUndefined();
      }
      if (youRole !== 'seer') {
        expect(view.you.seerChecks, `client ${i} received seer checks`).toBeUndefined();
      }
      if (youRole !== 'witch') {
        expect(view.you.witchPotions, `client ${i} received witch potions`).toBeUndefined();
      }
      // The kill target exists only inside the witch's own decision window.
      if (view.you.witchPotions?.killTarget !== undefined) {
        expect(
          youRole === 'witch' && view.step.kind === 'night' && view.step.step === 'witch',
          `killTarget visible to client ${i} outside the witch window`,
        ).toBe(true);
      }
    }
    for (const e of rec.events) {
      expect(SERVER_TYPES.has(e.type), `client ${i} received server event ${e.type}`).toBe(false);
      if (e.type === 'DEATH_ANNOUNCED') {
        expect(e, 'death announcement carries a cause').not.toHaveProperty('cause');
      }
    }
    // Voice relay never echoes the speaker's own frames back to their socket.
    const mySeat = rec.latest?.you.seat ?? null;
    for (const chunk of rec.voiceChunks) {
      expect(chunk.seat, `client ${i} (seat ${mySeat}) received its own voice chunk`).not.toBe(
        mySeat,
      );
    }
    // Assistant replies carry only the validated strategy shape — never role
    // data, private extras, or a raw view.
    for (const ack of rec.acks) {
      if (typeof ack !== 'object' || ack === null || !('lines' in ack)) continue;
      expect(Object.keys(ack).sort(), `client ${i} assistant ack carried extra fields`).toEqual([
        'lines',
        'reasoning',
        'warnings',
      ]);
    }
  }
}
