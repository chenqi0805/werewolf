import type {
  BoardId,
  GameAction,
  GameEvent,
  GameState,
  PlayerAction,
  Seat,
  SeatAssignment,
} from '@werewolf/engine';
import { SEAT_COUNT } from '@werewolf/engine';
import { applyAction, createGame } from '@werewolf/engine';
import { RoomError } from './errors';
import { currentSpeechSlot, type SpeechSlot } from './voice';
import { shuffledDeck } from './deck';
import { hashToken, makeRoomCode, makeToken } from './ids';
import { defaultActionsFor } from './defaults';

/** Where an applied action came from — provenance in the persisted stream. */
export type ActionSource = 'player' | 'server' | 'timer';

/** A seat as persisted: the token is stored hashed, never raw. */
export interface SeatTokenHash {
  seat: Seat;
  tokenHash: string;
}

/**
 * Persistence observers attached to a room by the registry. The Room knows
 * nothing about storage — hooks are plain synchronous callbacks invoked at
 * the moment the change is durable in memory. A room without hooks behaves
 * exactly like v1. Callbacks may throw (a failed store write fails loudly);
 * the action stream then simply ends at the last recorded action, which is
 * a consistent older state for replay.
 */
export interface RoomHooks {
  /** The room row must be written (room creation, restore re-attach). */
  onRoomChanged?: (room: Room) => void;
  /** One action was applied — append it to the room's action stream. */
  onAction?: (room: Room, action: GameAction, source: ActionSource) => void;
  /** The seat map changed (join) — rewrite the room's seat rows. */
  onSeatsChanged?: (room: Room) => void;
}

/** One seated identity: the bearer credential that survives a disconnect. */
export interface SeatRecord {
  seat: Seat;
  sessionToken: string;
}

/** Aggregated result of a room mutation — what the gateway fans out. */
export interface Applied {
  state: GameState;
  events: GameEvent[];
}

export interface RoomOptions {
  /** Assigned by the RoomRegistry; unique among live rooms. */
  code: string;
  /**
   * Test seam: a fixed deck instead of the crypto shuffle. Never reachable
   * through the Socket.IO gateway, which always deals randomly.
   */
  assignments?: SeatAssignment[];
  /** Which board to deal and validate against; classic until a picker ships. */
  boardId?: BoardId;
  /** Persistence observers; undefined = plain in-memory room. */
  hooks?: RoomHooks;
  /**
   * Restore path: adopt a replayed engine state and pre-seated token hashes
   * instead of dealing a fresh deck. Hooks still record post-restore play.
   */
  restored?: { state: GameState; seats: ReadonlyMap<Seat, string> };
}

/**
 * One game table. The Room owns the engine state and the seat-token map; it
 * knows nothing about sockets. All mutations go through the engine's
 * applyAction, so the room adds zero rule knowledge.
 */
export class Room {
  readonly code: string;

  /** seat → sha256(session token) — the hash is also the persisted form. */
  private readonly seats = new Map<Seat, string>();

  private currentState: GameState;

  private readonly hooks?: RoomHooks;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.hooks = opts.hooks;
    if (opts.restored) {
      this.currentState = opts.restored.state;
      for (const [seat, tokenHash] of opts.restored.seats) {
        this.seats.set(seat, tokenHash);
      }
    } else {
      const boardId = opts.boardId ?? 'classic';
      // createGame validates the board lineup; with a random deal this
      // cannot throw, and a fixed test deck fails fast here.
      this.currentState = createGame(opts.assignments ?? shuffledDeck(boardId), boardId);
    }
    this.hooks?.onRoomChanged?.(this);
  }

  get state(): GameState {
    return this.currentState;
  }

  get seatedCount(): number {
    return this.seats.size;
  }

  isFull(): boolean {
    return this.seats.size === SEAT_COUNT;
  }

  hasStarted(): boolean {
    return this.currentState.phase !== 'lobby';
  }

  isFinished(): boolean {
    return this.currentState.phase === 'game-over';
  }

  /** Lowest free seat, filled in join order. */
  join(): SeatRecord {
    if (this.hasStarted()) {
      throw new RoomError('GAME_RUNNING', 'The game is already running.');
    }
    const seat = this.firstFreeSeat();
    const sessionToken = makeToken();
    this.seats.set(seat, hashToken(sessionToken));
    this.hooks?.onSeatsChanged?.(this);
    return { seat, sessionToken };
  }

  /** Seat for a bearer token — the reconnect path. The token is hashed and
   * matched against the seat map, whose entries are hashes at rest. */
  reattach(token: string): Seat {
    const hash = hashToken(token);
    for (const [seat, known] of this.seats) {
      if (known === hash) return seat;
    }
    throw new RoomError('BAD_TOKEN', 'No seat matches this session token.');
  }

  /** Seats currently held by a session — the lobby's true occupancy. */
  occupiedSeats(): ReadonlySet<Seat> {
    return new Set(this.seats.keys());
  }

  /**
   * Lobby-only quit: frees the seat and kills the token, so the next join
   * reuses it and the old token cannot reattach. Once the game has started
   * a seat is gone for good — mid-game disconnects keep their reattach
   * path, so leave is rejected there. The seats-changed hook fires so a
   * persisted room cannot resurrect the quit seat on restore.
   */
  leave(seat: Seat): void {
    if (this.hasStarted()) {
      throw new RoomError('ALREADY_STARTED', 'The game has already started.');
    }
    if (!this.seats.has(seat)) {
      throw new RoomError('NO_SEAT', 'No session holds this seat.');
    }
    this.seats.delete(seat);
    this.hooks?.onSeatsChanged?.(this);
  }

  /** Seat hashes as persisted — raw tokens never outlive the join ack. */
  seatTokenHashes(): SeatTokenHash[] {
    return [...this.seats]
      .map(([seat, tokenHash]) => ({ seat, tokenHash }))
      .sort((a, b) => a.seat - b.seat);
  }

  /**
   * Starts the game. Any seated player may ask; the room must be full. The
   * START_GAME action is applied here, never accepted from a socket.
   */
  start(): Applied {
    if (!this.isFull()) {
      throw new RoomError('ROOM_NOT_FULL', `Start requires ${SEAT_COUNT} players.`);
    }
    if (this.hasStarted()) {
      throw new RoomError('ALREADY_STARTED', 'The game has already started.');
    }
    return this.apply({ type: 'START_GAME' }, 'server');
  }

  /** Applies a player action that passed gateway checks (seat, shape). */
  applyPlayerAction(action: PlayerAction): Applied {
    return this.apply(action, 'player');
  }

  /** Server pacing step — closing signup, ending a speech slot, and so on. */
  proceed(): Applied {
    return this.apply({ type: 'PROCEED' }, 'server');
  }

  /**
   * The Room-level mirror of the engine's SPEAK gate: whoever currently holds
   * a speech slot (day.ts handleSpeak's expected seat, all four contexts).
   * The voice relay validates frames against this before the engine sees one.
   */
  currentSpeechSlot(): SpeechSlot | null {
    return currentSpeechSlot(this.currentState);
  }

  /**
   * Timer expiry: injects the current phase's default actions. The batch is
   * computed once from the current snapshot; each action stays legal as the
   * state advances (the last injected vote resolves the ballot by itself).
   * Returns null when there was nothing to inject — the caller decides
   * whether to re-arm.
   */
  tick(): Applied | null {
    const actions = defaultActionsFor(this.currentState);
    if (actions.length === 0) return null;
    const events: GameEvent[] = [];
    for (const action of actions) {
      const result = this.apply(action, 'timer');
      events.push(...result.events);
    }
    return { state: this.currentState, events };
  }

  private apply(action: GameAction, source: ActionSource): Applied {
    const result = applyAction(this.currentState, action);
    this.currentState = result.state;
    this.hooks?.onAction?.(this, action, source);
    return result;
  }

  private firstFreeSeat(): Seat {
    for (let seat = 1; seat <= SEAT_COUNT; seat++) {
      if (!this.seats.has(seat)) return seat;
    }
    throw new RoomError('ROOM_FULL', 'Every seat is taken.');
  }
}

/** Live rooms keyed by join code. Rooms live for the process lifetime. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  /** Codes that must never be minted again (quarantined restores). */
  private readonly reservedCodes = new Set<string>();

  /**
   * Hook factory consulted at room construction; persistence attaches one
   * keyed by the room's code. Undefined = no persistence. Readable so the
   * restore path can hand replayed rooms the same hooks.
   */
  constructor(public readonly hooksFor?: (code: string) => RoomHooks | undefined) {}

  create(boardId: BoardId = 'classic'): Room {
    const code = makeRoomCode(this.takenCodes());
    const room = new Room({ code, boardId, hooks: this.hooksFor?.(code) });
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Adopt a fully replayed room (persistence restore path). */
  restore(room: Room): void {
    this.rooms.set(room.code, room);
  }

  /**
   * A code that exists on disk but is not playable (quarantined replay) must
   * never be minted: a fresh room colliding with the stale row would fail
   * its first persist. Live restored rooms join the taken set by simply
   * being in the registry.
   */
  reserveCode(code: string): void {
    this.reservedCodes.add(code);
  }

  private takenCodes(): Set<string> {
    return new Set([...this.rooms.keys(), ...this.reservedCodes]);
  }
}
