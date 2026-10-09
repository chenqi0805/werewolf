import type {
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
import { shuffledDeck } from './deck';
import { makeRoomCode, makeToken } from './ids';
import { defaultActionsFor } from './defaults';

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
}

/**
 * One game table. The Room owns the engine state and the seat-token map; it
 * knows nothing about sockets. All mutations go through the engine's
 * applyAction, so the room adds zero rule knowledge.
 */
export class Room {
  readonly code: string;

  private readonly seats = new Map<Seat, string>();

  private currentState: GameState;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    // createGame validates the standard lineup; with a random deal this
    // cannot throw, and a fixed test deck fails fast here.
    this.currentState = createGame(opts.assignments ?? shuffledDeck());
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
    this.seats.set(seat, sessionToken);
    return { seat, sessionToken };
  }

  /** Seat for a bearer token — the reconnect path. */
  reattach(token: string): Seat {
    for (const [seat, known] of this.seats) {
      if (known === token) return seat;
    }
    throw new RoomError('BAD_TOKEN', 'No seat matches this session token.');
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
    return this.apply({ type: 'START_GAME' });
  }

  /** Applies a player action that passed gateway checks (seat, shape). */
  applyPlayerAction(action: PlayerAction): Applied {
    return this.apply(action);
  }

  /** Server pacing step — closing signup, ending a speech slot, and so on. */
  proceed(): Applied {
    return this.apply({ type: 'PROCEED' });
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
      const result = applyAction(this.currentState, action);
      this.currentState = result.state;
      events.push(...result.events);
    }
    return { state: this.currentState, events };
  }

  private apply(action: GameAction): Applied {
    const result = applyAction(this.currentState, action);
    this.currentState = result.state;
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

  create(): Room {
    const room = new Room({ code: makeRoomCode(new Set(this.rooms.keys())) });
    this.rooms.set(room.code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }
}
