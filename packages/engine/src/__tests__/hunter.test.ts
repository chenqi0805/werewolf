import { describe, expect, it } from 'vitest';
import type { GameState } from '../index';
import {
  apply,
  baseGame,
  expectGameError,
  holdElection,
  newGame,
  nightKill,
  openDay,
  P,
  runNight,
  seerTurn,
  voteAll,
  witchTurn,
} from './harness';

/** Night 1 wolves kill the hunter; election; dawn opens his window. */
function night1HunterDead(): GameState {
  let s = apply(newGame(), { type: 'START_GAME' });
  s = runNight(s, { kill: 11 }); // hunter dies at dawn (witch passes, seer passes)
  s = holdElection(s, [9, 10], 9);
  s = apply(s, { type: 'PROCEED' }); // announce 11 → drain opens the shot window
  return s;
}

describe('hunter — shot windows', () => {
  it('a night-killed hunter opens his shot window at dawn', () => {
    const s = night1HunterDead();
    expect(s.phase).toBe('hunter-shot');
  });

  it('the shot target dies immediately with no last words', () => {
    let s = night1HunterDead();
    s = apply(s, { type: 'HUNTER_SHOOT', actor: 11, target: 7 });
    expect(P(s, 7).alive).toBe(false);
    // the day continues: the hunter’s own night-1 last words still happen,
    // but seat 7 (shot) is not in the queue
    expect(s.phase).toBe('last-words');
    expect(s.lastWords?.queue).toEqual([11]);
    expect(s.log.some((e) => e.type === 'HUNTER_SHOT' && e.shooter === 11 && e.target === 7)).toBe(
      true,
    );
  });

  it('shooting marks the hunter’s shot as used', () => {
    let s = night1HunterDead();
    s = apply(s, { type: 'HUNTER_SHOOT', actor: 11, target: 7 });
    expect(P(s, 11).private).toEqual({ kind: 'hunter', shotUsed: true });
  });

  it('the hunter may decline the shot', () => {
    let s = night1HunterDead();
    s = apply(s, { type: 'HUNTER_PASS', actor: 11 });
    expect(s.phase).toBe('last-words');
    expect(P(s, 11).private).toEqual({ kind: 'hunter', shotUsed: false });
  });

  it('an exiled hunter gets his shot', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = holdElection(s, [9, 10], 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 11); // exile the hunter
    expect(s.phase).toBe('hunter-shot');
    s = apply(s, { type: 'HUNTER_SHOOT', actor: 11, target: 1 }); // take a wolf down
    expect(P(s, 1).alive).toBe(false);
    expect(s.phase).toBe('night'); // day 1 done
    expect(s.dayNumber).toBe(2);
  });

  it('only the dying hunter may fire, at a non-self target', () => {
    const s = night1HunterDead();
    expectGameError(s, { type: 'HUNTER_SHOOT', actor: 10, target: 7 }, 'NOT_YOUR_TURN');
    expectGameError(s, { type: 'HUNTER_SHOOT', actor: 11, target: 11 }, 'INVALID_TARGET');
  });

  it('cannot shoot a dead player', () => {
    let s = baseGame(); // villager 5 died on night 1
    s = voteAll(s, 'EXILE_VOTE', 11); // exile the hunter → window
    expect(s.phase).toBe('hunter-shot');
    expectGameError(s, { type: 'HUNTER_SHOOT', actor: 11, target: 5 }, 'PLAYER_DEAD');
  });
});

describe('hunter — poison silences the shot', () => {
  it('a poisoned hunter has no window and cannot shoot', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, null); // 空刀
    s = witchTurn(s, { poison: 11 }); // poison the hunter
    s = seerTurn(s, 1);
    s = holdElection(s, [9, 10], 9);
    s = apply(s, { type: 'PROCEED' }); // announce 11 — no shot window
    expect(s.phase).toBe('last-words');
    expectGameError(s, { type: 'HUNTER_SHOOT', actor: 11, target: 1 }, 'NOT_ELIGIBLE_SHOOTER');
  });

  it('poison plus a wolf kill the same night counts as poisoned — no shot', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 11); // wolves AND witch target the hunter
    s = witchTurn(s, { poison: 11 });
    s = seerTurn(s, 1);
    s = holdElection(s, [9, 10], 9);
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('last-words'); // straight past the shot
    expectGameError(s, { type: 'HUNTER_SHOOT', actor: 11, target: 1 }, 'NOT_ELIGIBLE_SHOOTER');
    // exactly one death was announced
    expect(s.log.filter((e) => e.type === 'DEATH_ANNOUNCED')).toHaveLength(1);
  });
});

describe('hunter — cascade with the badge', () => {
  it('shooting the badge holder opens the badge pass', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = holdElection(s, [9, 10], 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 11); // exile the hunter
    expect(s.phase).toBe('hunter-shot');
    s = apply(s, { type: 'HUNTER_SHOOT', actor: 11, target: 9 }); // shoot the sheriff
    expect(s.phase).toBe('badge-pass');
    s = apply(s, { type: 'SHERIFF_PASS', actor: 9, target: 12 });
    expect(P(s, 12).hasBadge).toBe(true);
    expect(P(s, 9).hasBadge).toBe(false);
    expect(s.phase).toBe('night'); // day 1 done
  });
});
