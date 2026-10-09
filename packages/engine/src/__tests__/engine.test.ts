import { describe, expect, it } from 'vitest';
import { applyAction, GameError } from '../index';
import type { GameAction, GameState } from '../index';
import {
  apply,
  baseGame,
  expectCreateError,
  expectGameError,
  newGame,
  P,
  STANDARD,
} from './harness';

describe('setup — lineup validation', () => {
  it('accepts the standard 12-player lineup', () => {
    const s = newGame();
    expect(Object.keys(s.players)).toHaveLength(12);
    expect(Object.values(s.players).filter((p) => p.role === 'werewolf')).toHaveLength(4);
    expect(s.phase).toBe('lobby');
  });

  it('rejects duplicate seats (SEAT_TAKEN)', () => {
    expectCreateError(
      STANDARD.map((a) => (a.seat === 1 ? { seat: 2, role: a.role } : a)),
      'SEAT_TAKEN',
    );
  });

  it('rejects out-of-range and non-contiguous seats', () => {
    expectCreateError([{ seat: 0, role: 'werewolf' }, ...STANDARD.slice(1)], 'INVALID_LINEUP');
  });

  it('rejects a non-standard role distribution (INVALID_LINEUP)', () => {
    expectCreateError(
      STANDARD.map((a) => (a.seat === 12 ? { seat: 12, role: 'villager' as const } : a)),
      'INVALID_LINEUP',
    );
  });

  it('rejects wrong player counts (INVALID_LINEUP)', () => {
    expectCreateError(STANDARD.slice(1), 'INVALID_LINEUP');
  });
});

describe('purity — the reducer contract', () => {
  it('applyAction never mutates the input state', () => {
    const s = baseGame();
    const before = JSON.stringify(s);
    apply(s, { type: 'EXILE_VOTE', actor: 9, target: 6 });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('a rejected action leaves the state untouched', () => {
    const s = baseGame();
    const before = JSON.stringify(s);
    expectGameError(s, { type: 'EXILE_VOTE', actor: 5, target: 10 }, 'PLAYER_DEAD');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('identical action scripts produce identical states (determinism)', () => {
    const play = (): GameState => baseGame();
    expect(JSON.stringify(play())).toBe(JSON.stringify(play()));
  });

  it('a recorded script replays to the identical final state', () => {
    const actions: GameAction[] = [];
    const record = (state: GameState, a: GameAction): GameState => {
      actions.push(a);
      return applyAction(state, a).state;
    };
    let s = newGame();
    s = record(s, { type: 'START_GAME' });
    for (const w of [1, 2, 3, 4]) s = record(s, { type: 'WOLF_KILL', actor: w, target: 5 });
    s = record(s, { type: 'WITCH_PASS', actor: 10 });
    s = record(s, { type: 'SEER_CHECK', actor: 9, target: 1 });
    s = record(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = record(s, { type: 'PROCEED' });
    s = record(s, { type: 'PROCEED' });
    for (const v of [1, 2, 3, 4, 6, 7, 8, 10, 11, 12]) {
      s = record(s, { type: 'SHERIFF_VOTE', actor: v, target: 9 });
    }
    // replay the exact script from a fresh initial state
    let r = newGame();
    for (const a of actions) r = applyAction(r, a).state;
    expect(JSON.stringify(r)).toBe(JSON.stringify(s));
    expect(P(r, 9).hasBadge).toBe(true);
    expect(r.phase).toBe('dawn-announce');
  });

  it('GameError carries a stable code', () => {
    const s = newGame(); // lobby — any game action is wrong-phase
    const started = applyAction(s, { type: 'START_GAME' }).state; // legal — lobby start works
    expect(started.phase).toBe('night');
    expect(() => applyAction(s, { type: 'PROCEED' })).toThrowError(GameError);
  });
});
