import type { PlayerAction, Seat } from '@werewolf/engine';
import type {
  ClientToServerEvents,
  ErrorPayload,
  PlayerView,
  ServerToClientEvents,
} from '@werewolf/server';
import { io, type Socket } from 'socket.io-client';

import { mulberry32, seedFromString } from './rng';
import { recentSpeechOf, type BotDecision, type BotStrategy } from './strategy';

/** Why a runner stopped playing. `game-over` is the normal end. */
export type BotEndReason = 'game-over' | 'stopped' | 'connect-failed' | 'bad-token';

export interface BotRunnerOptions {
  /**
   * Loopback URL of the room server. A callable so a runner scheduled before
   * its server binds (boot-time respawn on a port-0 test server) resolves
   * the address lazily; it throws while unbound and the retry loop re-asks.
   */
  url: string | (() => string);
  roomCode: string;
  /** The seat's bearer token — held server-side, never surfaced to browsers. */
  token: string;
  strategy: BotStrategy;
  /**
   * Seeded stream handed to every decision. Defaults to a stream seeded from
   * the token — stable across server restarts, distinct per seat, so scripted
   * play is reproducible in CI. An unseeded stream is a caller's choice.
   */
  rng?: () => number;
  /** Called once when the runner stops playing, for whatever reason. */
  onEnd?: (reason: BotEndReason) => void;
  /** Bounded connect budget: attempts × retry interval (default 40 × 250ms). */
  maxConnectAttempts?: number;
  connectRetryMs?: number;
}

/**
 * A bot player as the wire sees it: a loopback `socket.io-client` connection
 * that joins by room code like a human, consumes only its own fog-of-war
 * views, and emits `PlayerAction`s through the same gateway checks. The
 * server cannot tell a runner from a browser — that is the guarantee that
 * makes bots trustworthy.
 *
 * Decision cadence is view-driven: every fresh view offers the strategy one
 * decision, deduped by an action fingerprint so repeated broadcasts never
 * double-send. A `game:error` best-effort correlates to the last emission
 * (the wire carries no ids) and clears its fingerprint so the strategy can
 * re-decide on the next view instead of sitting silenced.
 */
export class BotRunner {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private running = false;
  private deciding = false;
  private latest: PlayerView | null = null;
  private readonly sent = new Set<string>();
  private lastEmitted: { fingerprint: string; at: number } | null = null;
  private readonly rng: () => number;

  constructor(private readonly opts: BotRunnerOptions) {
    this.rng = opts.rng ?? mulberry32(seedFromString(opts.token));
  }

  /** Fire and forget: connects (with retry), rejoins the seat, then plays. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  /** Stops playing and drops the connection. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.finish('stopped');
  }

  /** The seat this runner last saw itself in, or null before the first view. */
  get seat(): Seat | null {
    return this.latest?.you.seat ?? null;
  }

  private finish(reason: BotEndReason): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    this.opts.onEnd?.(reason);
  }

  private async connect(): Promise<void> {
    const maxAttempts = this.opts.maxConnectAttempts ?? 40;
    const retryMs = this.opts.connectRetryMs ?? 250;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.running) return;
      let url: string;
      try {
        url = typeof this.opts.url === 'function' ? this.opts.url() : this.opts.url;
      } catch {
        // Server not listening yet (boot-time respawn) — retry.
        await delay(retryMs);
        continue;
      }
      const ok = await this.tryConnect(url);
      if (ok || !this.running) return;
      await delay(retryMs);
    }
    this.running = false;
    this.finish('connect-failed');
  }

  private tryConnect(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, {
        transports: ['websocket'],
        // The runner owns its retry budget; a dropped transport re-enters the
        // connect loop explicitly, so no half-dead sockets accumulate.
        reconnection: false,
        timeout: 2000,
      });
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (!ok) {
          socket.removeAllListeners();
          socket.disconnect();
        }
        resolve(ok);
      };
      socket.once('connect', () => {
        this.attach(socket);
        // Rejoin works pre-game and mid-game alike — a restarted server
        // restored the seat's token, so the bot resumes its own body.
        socket.emit('room:rejoin', this.opts.roomCode, this.opts.token, (resp) => {
          if ('error' in resp) {
            this.running = false;
            this.finish('bad-token');
            resolve(true); // connected but unauthorized: the runner is done
          } else {
            settle(true);
          }
        });
      });
      socket.once('connect_error', () => settle(false));
    });
  }

  private attach(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
    this.socket = socket;
    socket.on('game:view', (view) => {
      this.latest = view;
      if (view.phase === 'game-over') {
        this.running = false;
        this.finish('game-over');
        return;
      }
      void this.decideOnce();
    });
    socket.on('game:error', (error: ErrorPayload) => {
      // Best-effort correlation: the wire carries no action ids, so an error
      // shortly after an emission almost certainly names it.
      const last = this.lastEmitted;
      if (last !== null && Date.now() - last.at < 1000) {
        this.sent.delete(last.fingerprint);
        this.lastEmitted = null;
      }
      debugRunner(this.opts.roomCode, error);
    });
    socket.on('disconnect', () => {
      if (this.running) {
        this.socket = null;
        void this.connect();
      }
    });
  }

  /** One strategy decision per view — serialized, deduped, then emitted. */
  private async decideOnce(): Promise<void> {
    if (this.deciding || !this.running) return;
    const view = this.latest;
    const seat = view?.you.seat;
    if (!view || seat === null) return;
    this.deciding = true;
    try {
      const decision = await this.opts.strategy.decide({
        view,
        recentSpeech: recentSpeechOf(view),
        rng: this.rng,
      });
      if (!decision || !this.running) return;
      if (decision.action.actor !== seat) return; // strategy bug — never send
      const fingerprint = fingerprintOf(view, decision.action);
      if (this.sent.has(fingerprint)) return;
      this.sent.add(fingerprint);
      this.lastEmitted = { fingerprint, at: Date.now() };
      this.emit(decision.action);
      this.emitSpeech(view, seat, decision);
    } finally {
      this.deciding = false;
    }
  }

  /** A decision may carry speech for the slot it currently holds. */
  private emitSpeech(view: PlayerView, seat: Seat, decision: BotDecision): void {
    if (decision.speech === undefined || decision.action.type === 'SPEAK') return;
    if (!holdsSpeechSlot(view, seat)) return;
    const speak: PlayerAction = { type: 'SPEAK', actor: seat, text: decision.speech };
    const fingerprint = fingerprintOf(view, speak);
    if (this.sent.has(fingerprint)) return;
    this.sent.add(fingerprint);
    this.lastEmitted = { fingerprint, at: Date.now() };
    this.emit(speak);
  }

  private emit(action: PlayerAction): void {
    this.socket?.emit('game:action', action);
  }
}

function holdsSpeechSlot(view: PlayerView, seat: Seat): boolean {
  if (!view.you.alive) return false;
  const step = view.step;
  if (step.kind === 'speech') return step.order !== null && step.order[step.cursor] === seat;
  if (step.kind === 'last-words') return step.queue[step.cursor] === seat;
  if (step.kind === 'sheriff-speech') return step.queue[step.cursor] === seat;
  if (step.kind === 'pk-speech') return step.tied[step.cursor] === seat;
  return false;
}

/**
 * Identity of one decision opportunity: day + phase + full step shape + the
 * action itself. A repeated broadcast re-offers the same opportunity and the
 * fingerprint suppresses the duplicate; a state change (cursor advance,
 * potion used) changes the step shape and re-arms the slot.
 */
function fingerprintOf(view: PlayerView, action: PlayerAction): string {
  const target = 'target' in action ? String(action.target) : '';
  return `${view.dayNumber}|${view.phase}|${JSON.stringify(view.step)}|${action.type}|${target}`;
}

function debugRunner(code: string, error: ErrorPayload): void {
  // Rejections are protocol noise worth seeing in logs (the bot is a loopback
  // client of this same process in the hosted deployment).
  console.error(`[werewolf] bot in room ${code}: ${error.code} — ${error.message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
