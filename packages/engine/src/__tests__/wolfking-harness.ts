import type { EngineConfig, GameAction, GameState, Seat, SeatAssignment } from '../index';
import { campOf } from '../types';
import { createGame } from '../create';
import { P, apply, applyAll, holdElection, openDay, seerTurn, voteAll, witchTurn } from './harness';
import type { DayOpenOpts, SpeechOpts } from './harness';

/**
 * The 预女猎守 deal used by the wolfking suites. Role seats mirror the classic
 * harness where possible: wolves 1-3, 白狼王 4, villagers 5-8, seer 9,
 * witch 10, hunter 11 — and the guard takes the last seat, 12.
 */
export const WOLF_KING_STANDARD: SeatAssignment[] = [
  { seat: 1, role: 'werewolf' },
  { seat: 2, role: 'werewolf' },
  { seat: 3, role: 'werewolf' },
  { seat: 4, role: 'white_wolf_king' },
  { seat: 5, role: 'villager' },
  { seat: 6, role: 'villager' },
  { seat: 7, role: 'villager' },
  { seat: 8, role: 'villager' },
  { seat: 9, role: 'seer' },
  { seat: 10, role: 'witch' },
  { seat: 11, role: 'hunter' },
  { seat: 12, role: 'guard' },
];

export function newWolfKingGame(config?: Partial<EngineConfig>): GameState {
  return createGame(WOLF_KING_STANDARD, 'wolfking', config);
}

/** Living wolf-camp seats (wolves + 白狼王) in seat order. */
export function livingWolvesWK(state: GameState): Seat[] {
  return Object.values(state.players)
    .filter((p) => p.alive && campOf(p.role) === 'wolf')
    .map((p) => p.seat);
}

/** Wolf-camp night kill: every living wolf-camp seat votes (wolves + 白狼王). */
export function nightKillWK(state: GameState, target: Seat | null): GameState {
  return applyAll(
    state,
    livingWolvesWK(state).map((w) => ({ type: 'WOLF_KILL', actor: w, target }) as GameAction),
  );
}

export interface NightOptsWK {
  /** Guard decision: a seat to protect, or null/undefined to pass (空守). */
  guard?: Seat | null;
  kill?: Seat | null;
  heal?: boolean;
  poison?: Seat;
  check?: Seat;
}

/** Full wolfking night: guard (if his turn is open) → wolves → witch → seer. */
export function runNightWK(state: GameState, opts: NightOptsWK = {}): GameState {
  let s = state;
  if (s.night?.guardTurn === 'pending') {
    s =
      opts.guard !== undefined && opts.guard !== null
        ? apply(s, { type: 'GUARD_PROTECT', actor: 12, target: opts.guard })
        : apply(s, { type: 'GUARD_PASS', actor: 12 });
  }
  s = nightKillWK(s, opts.kill ?? null);
  if (P(s, 10).alive) s = witchTurn(s, opts);
  if (P(s, 9).alive) s = seerTurn(s, opts.check);
  return s;
}

/**
 * Plays one quiet day into the next night: no sheriff is elected (empty
 * signup closes void), the day's speeches pass, and the exile vote abstains
 * to a void — the cheapest way to reach a later night.
 */
export function toNextNight(state: GameState, opts: DayOpenOpts & SpeechOpts = {}): GameState {
  const s = holdElection(state, [], null);
  const opened = openDay(s, opts);
  return voteAll(opened, 'EXILE_VOTE', null);
}
