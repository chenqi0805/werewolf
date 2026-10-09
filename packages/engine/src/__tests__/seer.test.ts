import { describe, expect, it } from 'vitest';
import { visibilityOf } from '../index';
import {
  apply,
  baseGame,
  expectGameError,
  newGame,
  nightKill,
  P,
  voteAll,
  witchTurn,
} from './harness';

describe('seer — camp checks', () => {
  it('a wolf check records wolf in the seer’s private state', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = witchTurn(s);
    s = apply(s, { type: 'SEER_CHECK', actor: 9, target: 1 });
    expect(P(s, 9).private).toEqual({ kind: 'seer', checks: { 1: 'wolf' } });
  });

  it('a god check records good', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = witchTurn(s);
    s = apply(s, { type: 'SEER_CHECK', actor: 9, target: 11 }); // hunter → good
    expect(P(s, 9).private).toEqual({ kind: 'seer', checks: { 11: 'good' } });
  });

  it('results accumulate across nights', () => {
    let s = baseGame(); // night 1 checked seat 1 → wolf
    s = voteAll(s, 'EXILE_VOTE', null); // → night 2
    s = nightKill(s, 6);
    s = witchTurn(s);
    s = apply(s, { type: 'SEER_CHECK', actor: 9, target: 12 }); // idiot → good
    expect(P(s, 9).private).toEqual({ kind: 'seer', checks: { 1: 'wolf', 12: 'good' } });
  });

  it('the result matches the target’s actual camp', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = witchTurn(s);
    s = apply(s, { type: 'SEER_CHECK', actor: 9, target: 2 }); // wolf 2
    const seer = P(s, 9);
    if (seer.private.kind !== 'seer') throw new Error('seer private state expected');
    expect(seer.private.checks[2]).toBe('wolf');
    const checked = s.log.find((e) => e.type === 'SEER_CHECKED');
    expect(checked && checked.type === 'SEER_CHECKED' && checked.result).toBe('wolf');
  });

  it('the seer cannot check herself', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = witchTurn(s);
    expectGameError(s, { type: 'SEER_CHECK', actor: 9, target: 9 }, 'INVALID_TARGET');
  });

  it('the seer cannot check a dead player', () => {
    let s = baseGame(); // 5 died on night 1
    s = voteAll(s, 'EXILE_VOTE', null); // → night 2
    s = nightKill(s, 6);
    s = witchTurn(s);
    expectGameError(s, { type: 'SEER_CHECK', actor: 9, target: 5 }, 'PLAYER_DEAD');
  });

  it('SEER_PASS declines the check and ends the night', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = witchTurn(s);
    s = apply(s, { type: 'SEER_PASS', actor: 9 });
    expect(s.phase).toBe('sheriff-signup'); // day 1 election opens
  });

  it('SEER_CHECKED is private to the seer; other night events stay server-side', () => {
    expect(visibilityOf({ type: 'SEER_CHECKED', actor: 9, target: 1, result: 'wolf' })).toEqual({
      kind: 'private',
      seats: [9],
    });
    expect(visibilityOf({ type: 'DEATH_RESOLVED', seat: 5, cause: 'wolf-kill' })).toEqual({
      kind: 'server',
    });
    expect(visibilityOf({ type: 'KILL_TARGET_SET', target: 5 })).toEqual({ kind: 'server' });
    expect(visibilityOf({ type: 'PLAYER_EXILED', seat: 5 })).toEqual({ kind: 'public' });
  });
});
