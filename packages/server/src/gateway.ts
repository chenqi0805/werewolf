import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { BoardId, GameEvent, PlayerAction, Seat } from '@werewolf/engine';
import { BOARDS, GameError } from '@werewolf/engine';
import { RoomError } from './errors';
import { BotManager } from './bots';
import type { BotStrategy } from '@werewolf/bots';
import { RoomRegistry, type Room } from './room';
import { clockKey, DEFAULT_TIMERS } from './defaults';
import { eventsForSeat, viewFor, type PlayerView, type TimerInfo } from './view';
import { EventStore, type TimerRowRaw } from './eventStore';
import { restoreRooms, storeHooksFor } from './persistence';
import { attachAssistant, type AssistantOptions, type StrategyReply } from './assistant';
import { attachInvites, type InviteOptions } from './invites';
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

/**
 * Display names are capped, never rejected — the same trim-and-cap shape as
 * MAX_SPEECH_LENGTH, but a name never blocks entry. Counted in code points
 * so CJK glyphs and emoji each count once, not per UTF-16 surrogate.
 */
const MAX_NAME_LENGTH = 12;

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const chars = [...trimmed];
  return chars.length > MAX_NAME_LENGTH ? chars.slice(0, MAX_NAME_LENGTH).join('') : trimmed;
}

export type Ack<T> = (resp: T | { error: string }) => void;

export interface CreateAck {
  roomCode: string;
  seat: Seat;
  sessionToken: string;
  /** The dealt board — echoed so the creator's UI can name the game. */
  board: BoardId;
  /** The stored display name — trimmed and capped server-side, so the echo is what stuck. */
  name: string;
}

export type JoinAck = CreateAck | { roomCode: string; spectator: true };

export interface RejoinAck {
  seat: Seat;
  /** The display name stored for this seat — '' when none was chosen. */
  name: string;
}

export interface OkAck {
  ok: true;
}

/** addBot ack: the seat the AI player took and its pool nickname. */
export interface AddBotAck {
  seat: Seat;
  name: string;
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
  'room:create': (
    payload: { board?: BoardId; name?: string } | undefined,
    ack: Ack<CreateAck>,
  ) => void;
  'room:join': (code: string, name: string | undefined, ack: Ack<JoinAck>) => void;
  'room:rejoin': (code: string, token: string, ack: Ack<RejoinAck>) => void;
  'room:start': (ack: Ack<OkAck>) => void;
  /** Lobby-only quit: frees the seat and kills the session token. */
  'room:leave': (ack: Ack<OkAck>) => void;
  /** Lobby-only: seat an AI player (lowest free seat, server-held token). */
  'room:addBot': (ack: Ack<AddBotAck>) => void;
  /** Lobby-only: retire an AI player and free its seat. */
  'room:removeBot': (seat: Seat, ack: Ack<OkAck>) => void;
  'game:action': (action: PlayerAction) => void;
  /** Raw mic audio from the current speaker of a speech slot; violations drop. */
  'voice:frame': (chunk: ArrayBuffer) => void;
  /** Ask the strategy assistant; the caller's own view is the only prompt source. */
  'assistant:strategy': (ack: Ack<StrategyReply>) => void;
  /** Email a join link to a friend; seated senders only, budgeted per seat. */
  'room:invite': (email: string, ack: Ack<OkAck>) => void;
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
  /**
   * Email-invite sender config. Unset = the event still exists and every
   * request acks INVITE_UNAVAILABLE; the lobby view hides the affordance.
   */
  invites?: InviteOptions;
}

/**
 * Wires the room world onto a Socket.IO server. Every socket holds at most
 * one room binding; fan-out is strictly per-socket (views differ per seat,
 * and events are visibility-filtered), so there is never a raw-state
 * broadcast. Returns a dispose that clears all room timers, plus the restore
 * re-arm hook used at boot when a store is attached.
 */
export function attachGateway(
  io: GatewayServer,
  registry: RoomRegistry,
  opts?: GatewayOptions,
  store?: EventStore,
  botManager?: BotManager,
): { dispose(): void; rearmRestored(room: Room, timer: TimerRowRaw | null): void } {
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
  // The returned flag is the lobby's capability hint — the view says whether
  // the 邮件邀请 affordance may show, with no extra round trip.
  const invitesAvailable = attachInvites(io, registry, opts?.invites);

  function bind(socket: GatewaySocket, roomCode: string, seat: Seat | null): void {
    // One room per socket: a socket already fanned out to another room leaves
    // it first. Keeping the old membership would feed a rebound socket its
    // previous room's views and events, projected for the new room's seat.
    if (socket.data.roomCode !== null && socket.data.roomCode !== roomCode) unbind(socket);
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
    socket.emit(
      'game:view',
      viewFor(
        room.state,
        seat,
        deadlines.get(room.code) ?? null,
        room.occupiedSeats(),
        room.botSeats(),
        invitesAvailable,
        room.seatNames(),
      ),
    );
  }

  /** Re-renders every lobby after join/leave — no game events, just fresh views. */
  function broadcastOccupancy(room: Room): void {
    const sockets = roomSockets.get(room.code);
    if (!sockets) return;
    for (const socket of sockets) {
      emitView(socket, room, socket.data.seat ?? null);
    }
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
      store?.clearTimer(room.code);
      return;
    }
    const ms = timers[key];
    if (ms === undefined) {
      deadlines.delete(room.code);
      store?.clearTimer(room.code);
      return;
    }
    scheduleTimer(room, key, Date.now() + ms);
  }

  /**
   * Shared scheduling core: sets the advertised deadline and books the
   * expiry. `endsAt` is absolute so a restored clock keeps its original
   * deadline. Every arm persists its re-arm data — the room_timers row is
   * what restore reads back.
   */
  function scheduleTimer(room: Room, key: string, endsAt: number): void {
    deadlines.set(room.code, { key, endsAt });
    const timer = setTimeout(
      () => {
        roomTimers.delete(room.code);
        void expireRoom(room);
      },
      Math.max(0, endsAt - Date.now()),
    );
    roomTimers.set(room.code, timer);
    store?.upsertTimer(room.code, key, endsAt);
  }

  /**
   * Restore path: re-arm a restored room's clock from its persisted
   * deadline. The absolute endsAt survives the restart, so clients see the
   * same countdown across it. A deadline already in the past schedules at
   * delay zero and resolves on the next tick — the same semantics as an
   * expiry that fired mid-downtime. A missing or stale row (its key no
   * longer matches the replayed state) falls back to a fresh full clock.
   */
  function rearmRestored(room: Room, timer: TimerRowRaw | null): void {
    const key = clockKey(room.state);
    if (key === null) return;
    if (timer !== null && timer.timerKey === key) {
      scheduleTimer(room, timer.timerKey, timer.endsAt);
      return;
    }
    armTimer(room);
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
      // A failed expiry must never leave the room timerless: re-arm from the
      // room's current state. If the tick advanced the phase before the hook
      // threw, the new phase gets its own fresh clock; if the tick itself
      // failed, the same key re-fires and expiry retries.
      armTimer(room);
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
    socket.on('room:create', (payload, ack) => {
      if (typeof ack !== 'function') return;
      // The board is creation-time data: it picks the dealt deck and the
      // frozen config. Absent reads as classic (v1 clients); anything else
      // that is not a registry id is rejected before a room is minted.
      const wire = (payload ?? {}) as { board?: unknown; name?: unknown };
      const requested = wire.board;
      // Own-property check: `in` walks the prototype chain, so a board id
      // like 'toString' used to slip past this guard and crash the process
      // inside shuffledDeck.
      if (
        requested !== undefined &&
        (typeof requested !== 'string' || !Object.hasOwn(BOARDS, requested))
      ) {
        ack({ error: 'INVALID_BOARD' });
        return;
      }
      try {
        const board = (requested as BoardId | undefined) ?? 'classic';
        const name = normalizeName(wire.name);
        const room = registry.create(board);
        const { seat, sessionToken } = room.join(name);
        bind(socket, room.code, seat);
        ack({ roomCode: room.code, seat, sessionToken, board, name });
        broadcastOccupancy(room);
      } catch (error) {
        // Same contract as room:join — a store failure (or any throw) is one
        // socket's error ack, never a process exit.
        ack({ error: errorPayload(error).code });
      }
    });

    socket.on('room:join', (...args: [string, string | undefined, Ack<JoinAck>]) => {
      // The ack is always the last argument: v2 clients emit (code, name, ack),
      // pre-name clients (code, ack). Accepting both arities keeps a stale tab
      // joining across a server upgrade — the never-hang contract.
      const ack = args.at(-1);
      if (typeof ack !== 'function') return;
      const [code, rawName] = args;
      if (typeof code !== 'string') return;
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
        const name = normalizeName(rawName);
        const { seat, sessionToken } = room.join(name);
        bind(socket, room.code, seat);
        ack({ roomCode: room.code, seat, sessionToken, board: room.boardId, name });
        broadcastOccupancy(room);
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
        ack({ seat, name: room.seatName(seat) });
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

    socket.on('room:leave', (ack) => {
      if (typeof ack !== 'function') return;
      const { roomCode, seat } = socket.data;
      const room = roomCode ? registry.get(roomCode) : undefined;
      if (!room || seat === null) {
        ack({ error: 'NOT_IN_ROOM' });
        return;
      }
      try {
        room.leave(seat);
      } catch (error) {
        ack({ error: errorPayload(error).code });
        return;
      }
      // The token died with the seat; the socket goes back to the connect
      // state and stops receiving this room's views.
      unbind(socket);
      ack({ ok: true });
      broadcastOccupancy(room);
    });

    // Lobby-only bot seating. Any seated human may call it — the room model
    // has no host identity, matching room:start's authorization. The raw
    // runner token stays server-side; the ack surfaces only seat + nickname.
    socket.on('room:addBot', (ack) => {
      if (typeof ack !== 'function') return;
      const { roomCode, seat } = socket.data;
      const room = roomCode ? registry.get(roomCode) : undefined;
      if (!room || seat === null) {
        ack({ error: 'NO_SEAT' });
        return;
      }
      if (!botManager) {
        ack({ error: 'BOTS_UNAVAILABLE' });
        return;
      }
      try {
        const added = botManager.addBot(room);
        ack({ seat: added.seat, name: added.name });
        broadcastOccupancy(room);
      } catch (error) {
        ack({ error: errorPayload(error).code });
      }
    });

    socket.on('room:removeBot', (botSeat, ack) => {
      if (typeof ack !== 'function') return;
      const { roomCode, seat } = socket.data;
      const room = roomCode ? registry.get(roomCode) : undefined;
      if (!room || seat === null) {
        ack({ error: 'NO_SEAT' });
        return;
      }
      if (typeof botSeat !== 'number' || !Number.isInteger(botSeat)) {
        ack({ error: 'BAD_ACTION' });
        return;
      }
      if (!botManager) {
        ack({ error: 'BOTS_UNAVAILABLE' });
        return;
      }
      try {
        botManager.removeBot(room, botSeat);
        ack({ ok: true });
        broadcastOccupancy(room);
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

  return {
    dispose: () => {
      for (const timer of roomTimers.values()) clearTimeout(timer);
      roomTimers.clear();
      deadlines.clear();
      voiceHub.dropAll();
    },
    rearmRestored,
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
  /** Custodian of the loopback runners for every bot seat. */
  botManager: BotManager;
  close(): Promise<void>;
}

/**
 * Full app: HTTP server + Socket.IO gateway over a fresh room registry.
 * Pass an httpServer to share an existing listener; otherwise one is created
 * unbound (call `listen` yourself — tests use port 0).
 *
 * Pass a dbPath to open the SQLite event store: every room mutation is
 * recorded synchronously and everything persisted is restored on boot —
 * rooms, seat tokens, speeches, votes, and running clocks survive restarts.
 * Without a dbPath the registry is in-memory (v1 behavior).
 */
/** createApp's full options: attach options plus the composition knobs. */
export interface AppOptions extends GatewayOptions {
  httpServer?: HttpServer;
  dbPath?: string;
  /** Bot brain factory — see BotManager. Omit for the scripted brain. */
  botStrategyFactory?: () => BotStrategy;
}

export function createApp(opts?: AppOptions): AppHandle {
  const httpServer = opts?.httpServer ?? createServer();
  const io: GatewayServer = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });
  const store = opts?.dbPath !== undefined ? new EventStore(opts.dbPath) : undefined;
  const registry = new RoomRegistry(store ? storeHooksFor(store) : undefined);
  // Bots are loopback clients of this very server, so the manager resolves
  // the listen address lazily — runners scheduled before `listen` retry
  // until it is bound (boot-time respawn in port-0 test servers).
  const botManager = new BotManager(() => {
    const address = httpServer.address();
    if (address !== null && typeof address === 'object') {
      return `http://127.0.0.1:${address.port}`;
    }
    throw new Error('server is not listening yet');
  }, opts?.botStrategyFactory);
  const gateway = attachGateway(io, registry, opts, store, botManager);
  if (store) {
    const summary = restoreRooms(store, registry, gateway.rearmRestored);
    // Respawned runners: every restored bot seat needs its player back.
    for (const code of summary.restored) {
      const room = registry.get(code);
      if (room) botManager.spawnFor(room);
    }
  }
  return {
    io,
    registry,
    httpServer,
    botManager,
    async close() {
      botManager.retireAll();
      gateway.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeAllConnections?.();
      store?.close();
    },
  };
}
