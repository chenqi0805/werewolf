import type { BoardId } from './boards';
import { BOARDS } from './boards';
import type { EngineConfig } from './config';
import type { GameEvent } from './events';
import { GameError } from './errors';
import type { Phase, PlayerState, Role, Seat } from './types';
import { SEAT_COUNT } from './types';

/**
 * How a player died. Causes feed interrupt eligibility (hunter/destruct
 * windows) and dawn announcements; only server events carry a cause.
 */
export type DeathCause = 'wolf-kill' | 'poison' | 'exile' | 'shot' | 'self-destruct';

/**
 * One resolved death and the interrupts it may still owe. The engine drains
 * these in FIFO order: badge 移交 first, then the hunter shot window, then any
 * cascade from the shot's own victim.
 */
export interface DeathRecord {
  seat: Seat;
  cause: DeathCause;
  hunterWindow: boolean;
  hunterWindowDone: boolean;
  /**
   * The dying 白狼王 may take a player with him — his own exile settlement
   * only: poison and the night kill silence the skill. The mid-speech
   * destruct is a player action, not a death window, so it never sets this.
   */
  destructWindow: boolean;
  destructWindowDone: boolean;
  badgePass: boolean;
  badgeDone: boolean;
  lastWordsEligible: boolean;
  announced: boolean;
}

export interface NightState {
  step: 'wolf' | 'witch' | 'seer';
  /**
   * The guard's decision slot on boards that wake him first (the state
   * `step` field keeps the v1 literals; the guard turn precedes the wolf
   * step). 'pending' — only GUARD_* actions are legal; 'done' — decided;
   * null — no guard on this board (the exact v1 night shape).
   */
  guardTurn: 'pending' | 'done' | null;
  /** Tonight's protection. Null when the guard passes or does not exist. */
  protectTarget: Seat | null;
  /** Wolf seat → kill target (or null for a 空刀 vote). Latest vote wins. */
  wolfVotes: Partial<Record<Seat, Seat | null>>;
  killTarget: Seat | null;
  /** The witch used the heal tonight. */
  healed: boolean;
  healUsedTonight: boolean;
  poisonTarget: Seat | null;
  poisonUsedTonight: boolean;
  /** True on nights where the witch may heal herself. */
  maySelfSave: boolean;
}

export interface ElectionState {
  candidates: Seat[];
  speechQueue: Seat[];
  speechCursor: number;
  /** 警下 electorate for the current ballot. */
  electorate: Seat[];
  votes: Partial<Record<Seat, Seat | null>>;
}

export interface VoteState {
  kind: 'sheriff' | 'exile';
  votes: Partial<Record<Seat, Seat | null>>;
  electorate: Seat[];
  /** True for a PK revote — a second tie voids the decision. */
  revote: boolean;
}

export interface PKState {
  kind: 'sheriff' | 'exile';
  /** Tied candidates, in seat order; they speak, then may not vote. */
  tied: Seat[];
  cursor: number;
  electorate: Seat[];
}

export interface DawnState {
  /** Announcements in order: night deaths by seat, or a single 平安夜. */
  pending: Array<DeathRecord | 'peace'>;
  announced: DeathRecord[];
}

export interface ResolutionState {
  /** `dawn` = night deaths resolving; `day` = exile/shot deaths. */
  origin: 'dawn' | 'day';
  queue: DeathRecord[];
  /** True once a death was applied during this step — gates the win check. */
  newDeaths: boolean;
}

export interface LastWordsState {
  queue: Seat[];
  cursor: number;
}

export interface SpeechState {
  /** `null` until the sheriff sets the direction (no badge → preset). */
  order: Seat[] | null;
  cursor: number;
}

export interface GameState {
  /** Which board dealt this game — registry id resolved at creation. */
  board: BoardId;
  phase: Phase;
  dayNumber: number;
  players: Record<Seat, PlayerState>;
  night: NightState | null;
  /** Last night's protection — the 连守 check reads this, not tonight's choice. */
  lastProtected: Seat | null;
  /** Night deaths awaiting their dawn announcement. */
  pendingDawn: DeathRecord[] | null;
  election: ElectionState | null;
  dawn: DawnState | null;
  resolution: ResolutionState | null;
  lastWords: LastWordsState | null;
  speech: SpeechState | null;
  pk: PKState | null;
  vote: VoteState | null;
  winner: 'wolves' | 'good' | null;
  /** Append-only: audit trail and replay source. */
  log: GameEvent[];
  config: EngineConfig;
}

/** Deep-clone via JSON round trip. GameState is plain JSON-safe data by design. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Range-checked player lookup; unknown seats are rejected up front. */
export function getPlayer(state: GameState, seat: Seat): PlayerState {
  if (!Number.isInteger(seat) || seat < 1 || seat > SEAT_COUNT) {
    throw new GameError('INVALID_TARGET', `Seat ${seat} is out of range 1..${SEAT_COUNT}.`);
  }
  const p = state.players[seat];
  if (!p) throw new GameError('INVALID_TARGET', `No player in seat ${seat}.`);
  return p;
}

/** Living players in seat order. */
export function livingPlayers(state: GameState): PlayerState[] {
  return Object.values(state.players)
    .filter((p) => p.alive)
    .sort((a, b) => a.seat - b.seat);
}

export function findRole(state: GameState, role: Role): PlayerState | undefined {
  return Object.values(state.players).find((p) => p.role === role);
}

export function freshNight(state: GameState): NightState {
  const guardFirst = BOARDS[state.board].nightOrder[0] === 'guard';
  return {
    step: 'wolf',
    // The guard wakes first on boards whose night order puts him ahead of
    // the wolves — and only while a living guard exists to act; a dead
    // guard's night proceeds exactly like the v1 shape.
    guardTurn: guardFirst && (findRole(state, 'guard')?.alive ?? false) ? 'pending' : null,
    protectTarget: null,
    wolfVotes: {},
    killTarget: null,
    healed: false,
    healUsedTonight: false,
    poisonTarget: null,
    poisonUsedTonight: false,
    maySelfSave: state.config.witchSelfSaveNights.includes(state.dayNumber),
  };
}

export function requireNight(state: GameState): NightState {
  if (!state.night) throw new GameError('WRONG_PHASE', 'No night is in progress.');
  return state.night;
}

export function requireVote(state: GameState, kind: 'sheriff' | 'exile'): VoteState {
  const v = state.vote;
  if (!v || v.kind !== kind) {
    throw new GameError('WRONG_PHASE', `No ${kind} vote is in progress.`);
  }
  return v;
}

/** Target must name a living player. */
export function requireLivingTarget(state: GameState, seat: Seat): PlayerState {
  const p = getPlayer(state, seat);
  if (!p.alive) throw new GameError('PLAYER_DEAD', `Seat ${seat} is dead.`);
  return p;
}
