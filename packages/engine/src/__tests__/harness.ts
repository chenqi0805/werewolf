import { expect } from 'vitest';
import type {
  EngineConfig,
  GameAction,
  GameState,
  Seat,
  SeatAssignment,
  GameError,
} from '../index';
import { createGame, applyAction } from '../index';

/** Non-null seat access for tests. */
export const P = (state: GameState, seat: Seat) => state.players[seat]!;

export const STANDARD: SeatAssignment[] = [
  { seat: 1, role: 'werewolf' },
  { seat: 2, role: 'werewolf' },
  { seat: 3, role: 'werewolf' },
  { seat: 4, role: 'werewolf' },
  { seat: 5, role: 'villager' },
  { seat: 6, role: 'villager' },
  { seat: 7, role: 'villager' },
  { seat: 8, role: 'villager' },
  { seat: 9, role: 'seer' },
  { seat: 10, role: 'witch' },
  { seat: 11, role: 'hunter' },
  { seat: 12, role: 'idiot' },
];

export function newGame(config?: EngineConfig): GameState {
  return createGame(STANDARD, config);
}

export function apply(state: GameState, action: GameAction): GameState {
  return applyAction(state, action).state;
}

export function applyAll(state: GameState, actions: GameAction[]): GameState {
  return actions.reduce((s, a) => apply(s, a), state);
}

/** Asserts the action throws a GameError with exactly this code. */
export function expectGameError(state: GameState, action: GameAction, code: string): void {
  try {
    applyAction(state, action);
  } catch (e) {
    expect((e as GameError).code).toBe(code);
    return;
  }
  throw new Error(`expected GameError ${code}, but the action was accepted`);
}

export function expectCreateError(assignments: SeatAssignment[], code: string): void {
  try {
    createGame(assignments);
  } catch (e) {
    expect((e as GameError).code).toBe(code);
    return;
  }
  throw new Error(`expected GameError ${code}, but createGame succeeded`);
}

export function livingWolves(state: GameState): Seat[] {
  return Object.values(state.players)
    .filter((p) => p.alive && p.role === 'werewolf')
    .map((p) => p.seat);
}

export interface NightOpts {
  kill?: Seat | null;
  wolves?: Seat[];
  heal?: boolean;
  poison?: Seat;
  check?: Seat;
}

/** Every living wolf votes (default: no kill). */
export function nightKill(state: GameState, target: Seat | null, byWolves?: Seat[]): GameState {
  const voters = byWolves ?? livingWolves(state);
  return applyAll(
    state,
    voters.map((w) => ({ type: 'WOLF_KILL', actor: w, target }) as GameAction),
  );
}

export function witchTurn(
  state: GameState,
  opts: { heal?: boolean; poison?: Seat } = {},
): GameState {
  let s = state;
  if (opts.heal) s = apply(s, { type: 'WITCH_HEAL', actor: 10 });
  if (opts.poison !== undefined) {
    s = apply(s, { type: 'WITCH_POISON', actor: 10, target: opts.poison });
  }
  return apply(s, { type: 'WITCH_PASS', actor: 10 });
}

export function seerTurn(state: GameState, check?: Seat): GameState {
  return check === undefined
    ? apply(state, { type: 'SEER_PASS', actor: 9 })
    : apply(state, { type: 'SEER_CHECK', actor: 9, target: check });
}

/** Runs a full night: wolves → witch (if alive) → seer (if alive). */
export function runNight(state: GameState, opts: NightOpts = {}): GameState {
  let s = nightKill(state, opts.kill ?? null, opts.wolves);
  if (P(s, 10).alive) s = witchTurn(s, opts);
  if (P(s, 9).alive) s = seerTurn(s, opts.check);
  return s;
}

/** Votes the given action from every electorate member (or an explicit list). */
export function voteAll(
  state: GameState,
  action: 'SHERIFF_VOTE' | 'EXILE_VOTE',
  target: Seat | null,
  voters?: Seat[],
): GameState {
  const list = voters ?? state.vote?.electorate ?? [];
  return applyAll(
    state,
    list.map((v) => ({ type: action, actor: v, target }) as GameAction),
  );
}

/** Day-1 election: signup, close signup, speech slots, one unanimous-able ballot. */
export function holdElection(
  state: GameState,
  candidates: Seat[],
  voteTarget: Seat | null,
): GameState {
  let s = state;
  for (const c of candidates) s = apply(s, { type: 'SHERIFF_SIGNUP', actor: c });
  s = apply(s, { type: 'PROCEED' });
  for (let i = 0; i < candidates.length; i++) s = apply(s, { type: 'PROCEED' });
  return voteAll(s, 'SHERIFF_VOTE', voteTarget);
}

export interface DayOpenOpts {
  /** Hunter's response when his window opens; default: pass. */
  hunterShoot?: Seat;
  /** Badge holder's response; default: destroy (撕毁). */
  badgeTo?: Seat | null;
}

/** PROCEEDs through dawn announcements, last words, and death interrupts. */
export function throughDayOpen(state: GameState, opts: DayOpenOpts = {}): GameState {
  let s = state;
  let guard = 0;
  for (;;) {
    if (
      s.phase !== 'dawn-announce' &&
      s.phase !== 'last-words' &&
      s.phase !== 'hunter-shot' &&
      s.phase !== 'badge-pass'
    ) {
      return s;
    }
    if (++guard > 80) throw new Error('throughDayOpen did not settle');
    if (s.phase === 'dawn-announce' || s.phase === 'last-words') {
      s = apply(s, { type: 'PROCEED' });
      continue;
    }
    const head = s.resolution?.queue[0];
    if (!head) throw new Error('interrupt opened without a pending death record');
    if (s.phase === 'hunter-shot') {
      s =
        opts.hunterShoot !== undefined
          ? apply(s, { type: 'HUNTER_SHOOT', actor: head.seat, target: opts.hunterShoot })
          : apply(s, { type: 'HUNTER_PASS', actor: head.seat });
    } else {
      s = apply(s, { type: 'SHERIFF_PASS', actor: head.seat, target: opts.badgeTo ?? null });
    }
  }
}

export interface SpeechOpts {
  direction?: 'cw' | 'ccw';
  speeches?: Partial<Record<Seat, string>>;
}

/** Runs the speech round: sets direction if the sheriff must, then PROCEEDs. */
export function speechRound(state: GameState, opts: SpeechOpts = {}): GameState {
  let s = state;
  if (s.speech?.order === null) {
    const sheriff = Object.values(s.players).find((p) => p.hasBadge);
    if (!sheriff) throw new Error('speech order unset but no badge holder found');
    s = apply(s, {
      type: 'SET_SPEECH_DIRECTION',
      actor: sheriff.seat,
      direction: opts.direction ?? 'cw',
    });
  }
  const order = s.speech?.order;
  if (!order) throw new Error(`speech order missing in phase ${s.phase}`);
  for (const seat of order) {
    const text = opts.speeches?.[seat];
    if (text !== undefined) s = apply(s, { type: 'SPEAK', actor: seat, text });
    s = apply(s, { type: 'PROCEED' });
  }
  return s;
}

/** Dawn + interrupts + speech round: ends at exile-vote (or game-over). */
export function openDay(state: GameState, opts: DayOpenOpts & SpeechOpts = {}): GameState {
  return speechRound(throughDayOpen(state, opts), opts);
}

/**
 * Shared baseline: night 1 kills villager 5 (witch passes, seer checks wolf 1),
 * seer 9 is elected sheriff, day 1 opens to the exile vote. 11 living.
 */
export function baseGame(config?: EngineConfig): GameState {
  let s = apply(newGame(config), { type: 'START_GAME' });
  s = runNight(s, { kill: 5, check: 1 });
  s = holdElection(s, [9, 10, 11], 9);
  s = openDay(s);
  return s;
}
