import { describe, expect, it } from 'vitest';
import type { GameState } from '../index';
import { applyAction, winCheck } from '../index';
import {
  apply,
  baseGame,
  expectGameError,
  holdElection,
  livingWolves,
  newGame,
  nightKill,
  openDay,
  P,
  runNight,
  seerTurn,
  voteAll,
  witchTurn,
} from './harness';

/**
 * Days 1–3 exile wolves 1–3 (villagers knifed nights 2–3, the election voided
 * on an empty podium); night 4 the last wolf (seat 4) knifes the hunter and
 * dawn 4 opens his shot window — the game riding on the shot.
 */
function dawnShotDecides(): GameState {
  let s = apply(newGame(), { type: 'START_GAME' });
  s = runNight(s, { kill: null }); // night 1: 空刀
  s = apply(s, { type: 'PROCEED' }); // empty podium voids the election
  s = openDay(s);
  s = voteAll(s, 'EXILE_VOTE', 1); // day 1 exiles wolf 1
  s = runNight(s, { kill: 5 });
  s = openDay(s);
  s = voteAll(s, 'EXILE_VOTE', 2); // day 2 exiles wolf 2
  s = runNight(s, { kill: 6 });
  s = openDay(s);
  s = voteAll(s, 'EXILE_VOTE', 3); // day 3 exiles wolf 3
  s = runNight(s, { kill: 11 }); // night 4: the last wolf knifes the hunter
  s = apply(s, { type: 'PROCEED' }); // dawn announce 11 → the shot window
  expect(s.phase).toBe('hunter-shot');
  return s;
}

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

describe('hunter — a dawn shot that decides the game', () => {
  it('shooting the last wolf during the dawn drain ends the game immediately', () => {
    const s = dawnShotDecides();
    const result = applyAction(s, { type: 'HUNTER_SHOOT', actor: 11, target: 4 });
    expect(P(result.state, 4).alive).toBe(false);
    expect(livingWolves(result.state)).toEqual([]);
    expect(winCheck(result.state)).toBe('good');
    expect(result.events.some((e) => e.type === 'GAME_OVER' && e.winner === 'good')).toBe(true);
    expect(result.state.phase).toBe('game-over');
    expect(result.state.winner).toBe('good');
    // No further phase opens — the pre-fix bug stranded a wolfless night.
    expectGameError(result.state, { type: 'PROCEED' }, 'WRONG_PHASE');
  });
});
