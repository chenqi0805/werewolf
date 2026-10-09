import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../index';
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
  speechRound,
  throughDayOpen,
  voteAll,
  witchTurn,
} from './harness';

/** Baseline at exile-vote; abstain into the next night. */
function intoNight2(state: GameState): GameState {
  return voteAll(state, 'EXILE_VOTE', null);
}

/** Baseline → quiet night 2 (空刀) → day 2 abstain → night 3. */
function intoNight3(state: GameState): GameState {
  let s = intoNight2(state);
  s = runNight(s, {});
  s = throughDayOpen(s);
  s = speechRound(s);
  return voteAll(s, 'EXILE_VOTE', null);
}

describe('witch — potion economy (once per game each)', () => {
  it('the heal is once per game', () => {
    let s = intoNight2(baseGame()); // heal unused through night 1 (she passed)
    s = nightKill(s, 6);
    s = apply(s, { type: 'WITCH_HEAL', actor: 10 }); // first use, night 2
    expect(s.night?.healed).toBe(true);
    expectGameError(s, { type: 'WITCH_HEAL', actor: 10 }, 'POTION_USED'); // second use, same night
  });

  it('the poison is once per game', () => {
    let s = baseGame();
    s = intoNight2(s);
    s = nightKill(s, 6);
    s = witchTurn(s, { poison: 7 }); // poison spent on night 2
    s = seerTurn(s, 1);
    s = throughDayOpen(s); // dawn: deaths 6 and 7; day 2 has no last words
    s = speechRound(s);
    s = voteAll(s, 'EXILE_VOTE', null); // → night 3
    s = nightKill(s, 8);
    expectGameError(s, { type: 'WITCH_POISON', actor: 10, target: 2 }, 'POTION_USED');
  });

  it('both potions in one night are allowed', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = apply(s, { type: 'WITCH_HEAL', actor: 10 });
    s = apply(s, { type: 'WITCH_POISON', actor: 10, target: 6 });
    expect(s.night?.healed).toBe(true);
    expect(s.night?.poisonTarget).toBe(6);
  });

  it('witchDoublePotion=false rejects a second potion tonight', () => {
    let s = apply(newGame({ ...DEFAULT_CONFIG, witchDoublePotion: false }), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = apply(s, { type: 'WITCH_HEAL', actor: 10 });
    expectGameError(s, { type: 'WITCH_POISON', actor: 10, target: 6 }, 'NOT_YOUR_TURN');
  });
});

describe('witch — self-targeting', () => {
  it('self-save is allowed on night 1', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 10); // the wolves knife the witch herself
    s = apply(s, { type: 'WITCH_HEAL', actor: 10 });
    expect(s.night?.healed).toBe(true);
    s = apply(s, { type: 'WITCH_PASS', actor: 10 }); // the pass ends her step
    s = seerTurn(s, 1);
    s = holdElection(s, [9, 11], 9); // day 1 always elects the sheriff before dawn
    s = openDay(s); // 平安夜 dawn → speech → exile-vote
    expect(P(s, 10).alive).toBe(true);
    expect(s.phase).toBe('exile-vote');
  });

  it('self-save is rejected after night 1', () => {
    let s = intoNight3(baseGame());
    s = nightKill(s, 10); // the wolves knife the witch on night 3
    expectGameError(s, { type: 'WITCH_HEAL', actor: 10 }, 'POTION_SELF_SAVE');
  });

  it('the witch can never poison herself', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    expectGameError(s, { type: 'WITCH_POISON', actor: 10, target: 10 }, 'POTION_SELF_SAVE');
  });
});

describe('witch — context', () => {
  it('the kill target is visible in state while the witch decides', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    expect(s.night?.killTarget).toBe(5);
  });

  it('a heal with no kill on the table is rejected', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, null);
    expectGameError(s, { type: 'WITCH_HEAL', actor: 10 }, 'WRONG_PHASE');
  });

  it('the witch pass ends her step; non-witch actors are rejected', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    expectGameError(s, { type: 'WITCH_HEAL', actor: 9 }, 'NOT_YOUR_TURN');
    s = apply(s, { type: 'WITCH_PASS', actor: 10 });
    expect(s.night?.step).toBe('seer');
  });
});
