import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { GameEvent, PlayerAction, Seat } from '@werewolf/engine';
import { GameError } from '@werewolf/engine';
import { RoomError } from './errors';
import { RoomRegistry, type Room } from './room';
import { clockKey, DEFAULT_TIMERS } from './defaults';
import { eventsForSeat, viewFor, type PlayerView, type TimerInfo } from './view';
import { attachAssistant, type AssistantOptions, type StrategyReply } from './assistant';
import { attachPostgame, type PostgameOptions, type PostgameReply } from './postgame';
import {
  currentSpeechSlot,
  handleVoiceFrame,
  VoiceHub,
  type SpeechSlot,
  type VoiceChunk,
  type VoiceOptions,
} from './voice';

/** Freeform speech longer than this is rejected as a bad action. */
const MAX_SPEECH_LENGTH = 2000;

type Ack<T> = (resp: T | { error: string }) => void;

export interface CreateAck {
  roomCode: string;
  seat: Seat;
  sessionToken: string;
}

export type JoinAck = CreateAck | { roomCode: string; spectator: true };

export interface RejoinAck {
  seat: Seat;
}

export interface OkAck {
  ok: true;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface ServerToClientEvents {
  /** Filtered snapshot, sent after every accepted change (and on attach). */
  'game:view': (view: PlayerView) => void;
  /** One event at a time, visibility-filtered per socket. */
  'game:event': (event: GameEvent) => void;
  /** Per-socket rejection — never a disconnect, never a 500. */
  'game:error': (error: ErrorPayload) => void;
  /** Relayed live-audio from the current speaker — never sent to the speaker. */
  'voice:chunk': (chunk: VoiceChunk) => void;
}

export interface ClientToServerEvents {
  'room:create': (ack: Ack<CreateAck>) => void;
  'room:join': (code: string, ack: Ack<JoinAck>) => void;
  'room:rejoin': (code: string, token: string, ack: Ack<RejoinAck>) => void;
  'room:start': (ack: Ack<OkAck>) => void;
  'game:action': (action: PlayerAction) => void;
  /** Raw mic audio from the current speaker of a speech slot; violations drop. */
  'voice:frame': (chunk: ArrayBuffer) => void;
  /** Ask the strategy assistant; the caller's own view is the only prompt source. */
  'assistant:strategy': (ack: Ack<StrategyReply>) => void;
  /** Ask for the post-game 复盘; any room viewer may arm the shared generation. */
  'postgame:analysis': (ack: Ack<PostgameReply>) => void;
}

export interface SocketData {
  roomCode: string | null;
  seat: Seat | null;
}

type GatewayServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<never, never>,
  SocketData
>;
type GatewaySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<never, never>,
  SocketData
>;

/** Per-phase clock overrides in ms, keyed by clockKey — tests shrink these. */
export type TimerOverrides = Record<string, number>;

export interface GatewayOptions {
  /** Phase clock overrides in ms, keyed by clockKey — tests shrink these. */
  timers?: TimerOverrides;
  /**
   * Voice relay + server-side STT fallback. Unset = relay only: frames still
   * fan out to the room, but slots without a client transcript pass silently
   * (no buffering, no OpenAI call).
   */
  voice?: VoiceOptions;
  /**
   * Strategy-assistant provider config. Unset = the event still exists and
   * every request acks ASSISTANT_UNAVAILABLE.
   */
  assistant?: AssistantOptions;
  /**
   * Post-game 复盘 provider config — same provider seams as `assistant` (the
   * deployment's env choice covers both). Unset = every request acks
   * ASSISTANT_UNAVAILABLE.
   */
  postgame?: PostgameOptions;
}

/**
 * Wires the room world onto a Socket.IO server. Every socket holds at most
 * one room binding; fan-out is strictly per-socket (views differ per seat,
 * and events are visibility-filtered), so there is never a raw-state
 * broadcast. Returns a dispose that clears all room timers.
 */
export function attachGateway(
  io: GatewayServer,
  registry: RoomRegistry,
  opts?: GatewayOptions,
): () => void {
  const timers: Record<string, number> = { ...DEFAULT_TIMERS, ...opts?.timers };
  const roomSockets = new Map<string, Set<GatewaySocket>>();
  const roomTimers = new Map<string, NodeJS.Timeout>();
  /** The step deadline currently advertised to joining/rejoining sockets. */
  const deadlines = new Map<string, TimerInfo>();
  const voiceHub = new VoiceHub(
    {
      socketsOf: (code) => roomSockets.get(code) ?? [],
    },
    opts?.voice ?? {},
  );
  attachAssistant(io, registry, opts?.assistant ?? {});
  attachPostgame(io, registry, opts?.postgame ?? {});

  function bind(socket: GatewaySocket, roomCode: string, seat: Seat | null): void {
    socket.data.roomCode = roomCode;
    socket.data.seat = seat;
    let set = roomSockets.get(roomCode);
    if (!set) {
      set = new Set();
      roomSockets.set(roomCode, set);
    }
    set.add(socket);
  }

  function unbind(socket: GatewaySocket): void {
    const code = socket.data.roomCode;
    socket.data.roomCode = null;
    socket.data.seat = null;
    if (!code) return;
    const set = roomSockets.get(code);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) roomSockets.delete(code);
  }

  function errorPayload(error: unknown): ErrorPayload {
    if (error instanceof GameError || error instanceof RoomError) {
      return { code: error.code, message: error.message };
    }
    return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
  }

  function emitView(socket: GatewaySocket, room: Room, seat: Seat | null): void {
    socket.emit('game:view', viewFor(room.state, seat, deadlines.get(room.code) ?? null));
  }

  function broadcast(room: Room, events: readonly GameEvent[]): void {
    // Arm the step clock first: every view this broadcast emits must already
    // carry the fresh deadline, never the expired one from the previous step.
    armTimer(room);
    const sockets = roomSockets.get(room.code);
    if (sockets) {
      for (const socket of sockets) {
        const seat = socket.data.seat ?? null;
        for (const event of eventsForSeat(events, seat)) {
          socket.emit('game:event', event);
        }
        emitView(socket, room, seat);
      }
    }
  }

  /** One clock per room, re-armed after every accepted change. */
  function armTimer(room: Room): void {
    const existing = roomTimers.get(room.code);
    if (existing) {
      clearTimeout(existing);
      roomTimers.delete(room.code);
    }
    const key = clockKey(room.state);
    if (key === null) {
      deadlines.delete(room.code);
      return;
    }
    const ms = timers[key];
    if (ms === undefined) {
      deadlines.delete(room.code);
      return;
    }
    deadlines.set(room.code, { key, endsAt: Date.now() + ms });
    const timer = setTimeout(() => {
      roomTimers.delete(room.code);
      void expireRoom(room);
    }, ms);
    roomTimers.set(room.code, timer);
  }

  /** Shared expiry step: the phase's default actions, applied and broadcast. */
  function finishExpiry(room: Room): void {
    try {
      const applied = room.tick();
      if (applied) {
        broadcast(room, applied.events);
      } else {
        console.error(
          `[werewolf] room ${room.code}: timer lapsed with no default to inject (phase ${room.state.phase})`,
        );
      }
    } catch (error) {
      console.error(`[werewolf] room ${room.code}: timer injection failed:`, error);
    }
  }

  /**
   * Timer expiry. In a speech slot this is also the fallback-transcript
   * deadline: with a pending buffer, an armed STT, and no client SPEAK, the
   * PROCEED defers by at most the STT deadline while the buffer is
   * transcribed and injected as the slot's speech.
   */
  async function expireRoom(room: Room): Promise<void> {
    try {
      const slot: SpeechSlot | null = currentSpeechSlot(room.state);
      if (slot === null || !voiceHub.fallbackArmed()) {
        finishExpiry(room);
        return;
      }
      const audio = voiceHub.takeBuffer(room.code, slot.key);
      if (audio === null) {
        finishExpiry(room);
        return;
      }
      const text = await voiceHub.transcribe(audio);
      // The deferral is the only window where state can move: a client SPEAK
      // re-arms the clock (the fresh timer owns the slot now), and a resolved
      // game has neither clock nor slot. Either way the pending PROCEED is
      // obsolete — this expiry's answer is done.
      if (roomTimers.has(room.code)) return;
      const again = currentSpeechSlot(room.state);
      if (again === null || again.key !== slot.key) return;
      if (text === null || text.trim() === '' || text.length > MAX_SPEECH_LENGTH) {
        finishExpiry(room);
        return;
      }
      try {
        // The transcript is the speech: the same apply path a client uses.
        const applied = room.applyPlayerAction({ type: 'SPEAK', actor: slot.seat, text });
        broadcast(room, applied.events);
      } catch (error) {
        console.error(`[werewolf] room ${room.code}: fallback transcript injection failed:`, error);
      }
      // Hand the floor over whether or not the transcript landed.
      finishExpiry(room);
    } catch (error) {
      // Defensive: the paths above are non-throwing by design; a surprise
      // must not double-tick the room. A lost expiry is logged, not retried —
      // the same semantics as the timer injection catch below.
      console.error(`[werewolf] room ${room.code}: speech-slot expiry failed:`, error);
    }
  }

  io.on('connection', (socket) => {
    socket.on('room:create', (ack) => {
      if (typeof ack !== 'function') return;
      const room = registry.create();
      const { seat, sessionToken } = room.join();
      bind(socket, room.code, seat);
      ack({ roomCode: room.code, seat, sessionToken });
      emitView(socket, room, seat);
    });

    socket.on('room:join', (code, ack) => {
      if (typeof ack !== 'function' || typeof code !== 'string') return;
      const room = registry.get(code);
      if (!room) {
        ack({ error: 'ROOM_NOT_FOUND' });
        return;
      }
      if (room.isFinished()) {
        // A finished room accepts anyone as a spectator, full reveal.
        bind(socket, room.code, null);
        ack({ roomCode: room.code, spectator: true });
        emitView(socket, room, null);
        return;
      }
      try {
        const { seat, sessionToken } = room.join();
        bind(socket, room.code, seat);
        ack({ roomCode: room.code, seat, sessionToken });
        emitView(socket, room, seat);
      } catch (error) {
        ack({ error: errorPayload(error).code });
      }
    });

    socket.on('room:rejoin', (code, token, ack) => {
      if (typeof ack !== 'function' || typeof code !== 'string' || typeof token !== 'string') {
        return;
      }
      const room = registry.get(code);
      if (!room) {
        ack({ error: 'ROOM_NOT_FOUND' });
        return;
      }
      try {
        const seat = room.reattach(token);
        bind(socket, room.code, seat);
        ack({ seat });
        // The view carries the seat's full visible log — the backlog.
        emitView(socket, room, seat);
      } catch (error) {
        ack({ error: errorPayload(error).code });
      }
    });

    socket.on('room:start', (ack) => {
      if (typeof ack !== 'function') return;
      const { roomCode, seat } = socket.data;
      const room = roomCode ? registry.get(roomCode) : undefined;
      if (!room || seat === null) {
        ack({ error: 'NO_SEAT' });
        return;
      }
      try {
        const applied = room.start();
        ack({ ok: true });
        broadcast(room, applied.events);
      } catch (error) {
        ack({ error: errorPayload(error).code });
      }
    });

    socket.on('game:action', (raw) => {
      const { roomCode, seat } = socket.data;
      const room = roomCode ? registry.get(roomCode) : undefined;
      if (!room) {
        socket.emit('game:error', { code: 'NOT_IN_ROOM', message: 'Join a room first.' });
        return;
      }
      if (seat === null) {
        socket.emit('game:error', { code: 'NO_SEAT', message: 'Spectators cannot act.' });
        return;
      }
      if (isServerActionShape(raw)) {
        socket.emit('game:error', {
          code: 'SERVER_ACTION_FORBIDDEN',
          message: 'Server control actions are injected by the server only.',
        });
        return;
      }
      if (!isShapedAction(raw)) {
        socket.emit('game:error', { code: 'BAD_ACTION', message: 'Malformed action.' });
        return;
      }
      if (raw.type === 'SPEAK' && raw.text.length > MAX_SPEECH_LENGTH) {
        socket.emit('game:error', { code: 'BAD_ACTION', message: 'Speech is too long.' });
        return;
      }
      if (raw.actor !== seat) {
        socket.emit('game:error', {
          code: 'NOT_YOUR_SEAT',
          message: `You hold seat ${seat}, not seat ${raw.actor}.`,
        });
        return;
      }
      try {
        const applied = room.applyPlayerAction(raw);
        broadcast(room, applied.events);
      } catch (error) {
        socket.emit('game:error', errorPayload(error));
      }
    });

    socket.on('voice:frame', (chunk) => {
      const { roomCode, seat } = socket.data;
      handleVoiceFrame(voiceHub, registry, roomCode, seat, socket, chunk);
    });

    socket.on('disconnect', () => {
      unbind(socket);
    });
  });

  return () => {
    for (const timer of roomTimers.values()) clearTimeout(timer);
    roomTimers.clear();
    deadlines.clear();
    voiceHub.dropAll();
  };
}

/** Shape guard before the engine sees the payload. */
function isShapedAction(value: unknown): value is PlayerAction {
  if (typeof value !== 'object' || value === null) return false;
  const { type, actor } = value as { type?: unknown; actor?: unknown };
  if (typeof type !== 'string') return false;
  if (type === 'SPEAK' && typeof (value as { text?: unknown }).text !== 'string') return false;
  return typeof actor === 'number' && Number.isInteger(actor);
}

/** Server control actions on the wire are a protocol violation, not a move. */
function isServerActionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'START_GAME' || type === 'PROCEED';
}

export interface AppHandle {
  io: GatewayServer;
  registry: RoomRegistry;
  httpServer: HttpServer;
  close(): Promise<void>;
}

/**
 * Full app: HTTP server + Socket.IO gateway over a fresh room registry.
 * Pass an httpServer to share an existing listener; otherwise one is created
 * unbound (call `listen` yourself — tests use port 0).
 */
export function createApp(opts?: GatewayOptions & { httpServer?: HttpServer }): AppHandle {
  const httpServer = opts?.httpServer ?? createServer();
  const io: GatewayServer = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });
  const registry = new RoomRegistry();
  const dispose = attachGateway(io, registry, opts);
  return {
    io,
    registry,
    httpServer,
    async close() {
      dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeAllConnections?.();
    },
  };
}
