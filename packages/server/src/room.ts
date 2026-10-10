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
import { pickBotNickname } from './botNames';
import { shuffledDeck } from './deck';
import { hashToken, makeRoomCode, makeToken } from './ids';
import { defaultActionsFor } from './defaults';

/** Where an applied action came from — provenance in the persisted stream. */
export type ActionSource = 'player' | 'server' | 'timer';

/** A seat row as persisted: the token is stored hashed, never raw. */
export interface SeatRow {
  seat: Seat;
  tokenHash: string;
  /** The seat's display name, restored verbatim across restarts. */
  name: string;
}

/**
 * Persistence observers attached to a room by the registry. The Room knows
 * nothing about storage — hooks are plain synchronous callbacks invoked at
 * the moment the change is durable in memory. A room without hooks behaves
 * exactly like v1. Callbacks may throw (a failed store write fails loudly);
 * the room then rolls its memory back to the pre-action state, so the
 * action stream simply ends at the last recorded action and memory stays
 * prefix-consistent with it — a consistent older state for replay.
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

/**
 * What one seated human identity stores at rest: the hashed bearer
 * credential plus the display name chosen at the door. Names are room
 * metadata — the engine's GameState never learns them.
 */
export interface SeatIdentity {
  tokenHash: string;
  /** Trimmed and capped by the gateway at join; '' falls back to the seat label. */
  name: string;
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
   * `bots` lists which seats are AI players — their nicknames are re-drawn
   * from the pool in seat order (names are cosmetic; only bot-ness is
   * durable) and their raw tokens are reminted by the bot manager.
   */
  restored?: {
    state: GameState;
    seats: ReadonlyMap<Seat, SeatIdentity>;
    bots?: ReadonlySet<Seat>;
  };
}

/**
 * One game table. The Room owns the engine state and the seat records
 * (token hash + display name); it knows nothing about sockets. All mutations
 * go through the engine's applyAction, so the room adds zero rule knowledge.
 */
export class Room {
  readonly code: string;

  /** seat → token hash (at rest) + display name chosen at the door. */
  private readonly seats = new Map<Seat, SeatIdentity>();

  /** seat → server-picked nickname; membership here means the seat is a bot. */
  private readonly botNames = new Map<Seat, string>();

  private currentState: GameState;

  private readonly hooks?: RoomHooks;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.hooks = opts.hooks;
    if (opts.restored) {
      this.currentState = opts.restored.state;
      for (const [seat, identity] of opts.restored.seats) {
        this.seats.set(seat, identity);
      }
      if (opts.restored.bots) {
        for (const seat of [...opts.restored.bots].sort((a, b) => a - b)) {
          this.botNames.set(seat, pickBotNickname(new Set(this.botNames.values())));
        }
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

  /** The dealt board — authoritative for restored rooms too (replayed state). */
  get boardId(): BoardId {
    return this.currentState.board;
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

  /** Lowest free seat, filled in join order. The name is already
   * gateway-normalized (trimmed, capped); the room stores it verbatim. */
  join(name = ''): SeatRecord {
    if (this.hasStarted()) {
      throw new RoomError('GAME_RUNNING', 'The game is already running.');
    }
    const seat = this.firstFreeSeat();
    const sessionToken = makeToken();
    this.seats.set(seat, { tokenHash: hashToken(sessionToken), name });
    this.hooks?.onSeatsChanged?.(this);
    return { seat, sessionToken };
  }

  /** Seat for a bearer token — the reconnect path. The token is hashed and
   * matched against the seat map, whose entries are hashes at rest. */
  reattach(token: string): Seat {
    const hash = hashToken(token);
    for (const [seat, identity] of this.seats) {
      if (identity.tokenHash === hash) return seat;
    }
    throw new RoomError('BAD_TOKEN', 'No seat matches this session token.');
  }

  /** Seats currently held by a session — the lobby's true occupancy. */
  occupiedSeats(): ReadonlySet<Seat> {
    return new Set(this.seats.keys());
  }

  /** The display name one seat chose at the door; '' = none (label fallback). */
  seatName(seat: Seat): string {
    return this.seats.get(seat)?.name ?? '';
  }

  /** seat → display name — the view's PlayerRow.name, like botSeats(). */
  seatNames(): ReadonlyMap<Seat, string> {
    const names = new Map<Seat, string>();
    for (const [seat, identity] of this.seats) {
      if (identity.name !== '') names.set(seat, identity.name);
    }
    return names;
  }

  /** seat → nickname for every AI seat — the view's badge and label. */
  botSeats(): ReadonlyMap<Seat, string> {
    return this.botNames;
  }

  isBotSeat(seat: Seat): boolean {
    return this.botNames.has(seat);
  }

  /**
   * Seats an AI player like a human (lowest free seat, minted token) and
   * names it from the pool. Lobby-only — the bot manager receives the raw
   * token for its loopback runner; the browser never sees it.
   */
  addBot(): { seat: Seat; name: string; token: string } {
    if (this.hasStarted()) {
      throw new RoomError('ALREADY_STARTED', 'Bots join in the lobby only.');
    }
    const seat = this.firstFreeSeat();
    const token = makeToken();
    this.seats.set(seat, { tokenHash: hashToken(token), name: '' });
    const name = pickBotNickname(new Set(this.botNames.values()));
    this.botNames.set(seat, name);
    this.hooks?.onSeatsChanged?.(this);
    return { seat, name, token };
  }

  /** Lobby-only bot retirement: frees the seat and its nickname. */
  removeBot(seat: Seat): void {
    if (this.hasStarted()) {
      throw new RoomError('ALREADY_STARTED', 'Bots leave in the lobby only.');
    }
    if (!this.botNames.has(seat)) {
      throw new RoomError('NOT_A_BOT', 'No bot sits in this seat.');
    }
    this.botNames.delete(seat);
    this.seats.delete(seat);
    this.hooks?.onSeatsChanged?.(this);
  }

  /**
   * Restore path only: mint a fresh raw token for a bot seat whose stored
   * hash has no raw counterpart on this machine (tokens are hashed at rest).
   * The bot manager hands the raw token to the seat's loopback runner;
   * reminting is restricted to bots so no human session can be invalidated.
   */
  remintBotToken(seat: Seat): string {
    if (!this.botNames.has(seat)) {
      throw new RoomError('NOT_A_BOT', 'Only bot seats may remint tokens.');
    }
    const token = makeToken();
    this.seats.set(seat, { tokenHash: hashToken(token), name: '' });
    this.hooks?.onSeatsChanged?.(this);
    return token;
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
    this.botNames.delete(seat);
    this.hooks?.onSeatsChanged?.(this);
  }

  /** Seat rows as persisted — raw tokens never outlive the join ack. */
  seatRows(): SeatRow[] {
    return [...this.seats]
      .map(([seat, identity]) => ({ seat, tokenHash: identity.tokenHash, name: identity.name }))
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
    const previous = this.currentState; // pure reducer: rollback is a reassign
    const result = applyAction(previous, action);
    this.currentState = result.state;
    try {
      this.hooks?.onAction?.(this, action, source); // appendAction lives here
    } catch (error) {
      // A failed store write must leave memory matching the log — the stream
      // "simply ends at the last recorded action", for real.
      this.currentState = previous;
      throw error;
    }
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

  /**
   * Eviction (the empty-lobby TTL): drop the room and retire its code. The
   * code is reserved even when no store is attached — with one attached, the
   * evicted room's rows persist on disk, and a re-minted code would collide
   * with them on the next restore.
   */
  remove(code: string): void {
    this.rooms.delete(code);
    this.reservedCodes.add(code);
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
