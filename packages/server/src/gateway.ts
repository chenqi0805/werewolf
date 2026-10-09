import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { GameEvent, PlayerAction, Seat } from '@werewolf/engine';
import { GameError } from '@werewolf/engine';
import { RoomError } from './errors';
import { RoomRegistry, type Room } from './room';
import { clockKey, DEFAULT_TIMERS } from './defaults';
import { eventsForSeat, viewFor, type PlayerView } from './view';

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
}

export interface ClientToServerEvents {
  'room:create': (ack: Ack<CreateAck>) => void;
  'room:join': (code: string, ack: Ack<JoinAck>) => void;
  'room:rejoin': (code: string, token: string, ack: Ack<RejoinAck>) => void;
  'room:start': (ack: Ack<OkAck>) => void;
  'game:action': (action: PlayerAction) => void;
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
  timers?: TimerOverrides;
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

  function broadcast(room: Room, events: readonly GameEvent[]): void {
    const sockets = roomSockets.get(room.code);
    if (sockets) {
      for (const socket of sockets) {
        const seat = socket.data.seat ?? null;
        for (const event of eventsForSeat(events, seat)) {
          socket.emit('game:event', event);
        }
        socket.emit('game:view', viewFor(room.state, seat));
      }
    }
    armTimer(room);
  }

  /** One clock per room, re-armed after every accepted change. */
  function armTimer(room: Room): void {
    const existing = roomTimers.get(room.code);
    if (existing) {
      clearTimeout(existing);
      roomTimers.delete(room.code);
    }
    const key = clockKey(room.state);
    if (key === null) return;
    const ms = timers[key];
    if (ms === undefined) return;
    const timer = setTimeout(() => {
      roomTimers.delete(room.code);
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
    }, ms);
    roomTimers.set(room.code, timer);
  }

  io.on('connection', (socket) => {
    socket.on('room:create', (ack) => {
      if (typeof ack !== 'function') return;
      const room = registry.create();
      const { seat, sessionToken } = room.join();
      bind(socket, room.code, seat);
      ack({ roomCode: room.code, seat, sessionToken });
      socket.emit('game:view', viewFor(room.state, seat));
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
        socket.emit('game:view', viewFor(room.state, null));
        return;
      }
      try {
        const { seat, sessionToken } = room.join();
        bind(socket, room.code, seat);
        ack({ roomCode: room.code, seat, sessionToken });
        socket.emit('game:view', viewFor(room.state, seat));
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
        socket.emit('game:view', viewFor(room.state, seat));
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

    socket.on('disconnect', () => {
      unbind(socket);
    });
  });

  return () => {
    for (const timer of roomTimers.values()) clearTimeout(timer);
    roomTimers.clear();
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
