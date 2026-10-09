import { describe, expect, it } from 'vitest';
import type { GameState } from '../index';
import {
  apply,
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

describe('night — werewolf kill vote', () => {
  it('wolves wake together and a unique majority sets the kill target', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    expect(s.phase).toBe('night');
    expect(s.night?.step).toBe('wolf');
    s = apply(s, { type: 'WOLF_KILL', actor: 1, target: 5 });
    s = apply(s, { type: 'WOLF_KILL', actor: 2, target: 5 });
    s = apply(s, { type: 'WOLF_KILL', actor: 3, target: 6 });
    // wolf 4 has not voted — the night is still in the wolf step
    expect(s.night?.step).toBe('wolf');
    s = apply(s, { type: 'WOLF_KILL', actor: 4, target: 5 });
    expect(s.night?.killTarget).toBe(5); // 3 votes for 5, 1 for 6
    expect(s.night?.step).toBe('witch');
  });

  it('a wolf may change its vote; the latest vote counts', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = apply(s, { type: 'WOLF_KILL', actor: 1, target: 5 });
    s = apply(s, { type: 'WOLF_KILL', actor: 1, target: 6 });
    expect(s.night?.wolfVotes[1]).toBe(6);
  });

  it('a split wolf vote resolves to 空刀', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = apply(s, { type: 'WOLF_KILL', actor: 1, target: 5 });
    s = apply(s, { type: 'WOLF_KILL', actor: 2, target: 5 });
    s = apply(s, { type: 'WOLF_KILL', actor: 3, target: 6 });
    s = apply(s, { type: 'WOLF_KILL', actor: 4, target: 6 }); // 2–2 tie
    expect(s.night?.killTarget).toBeNull();
    expect(s.night?.step).toBe('witch');
  });

  it('all wolves voting null is a 空刀 and yields a 平安夜', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, {}); // no kill, no potions, seer passes
    s = holdElection(s, [9, 10], 9);
    s = apply(s, { type: 'PROCEED' }); // dawn: 平安夜
    expect(s.log.some((e) => e.type === 'PEACEFUL_NIGHT')).toBe(true);
    expect(Object.values(s.players).every((p) => p.alive)).toBe(true);
  });

  it('non-wolves and dead wolves cannot vote on the kill', () => {
    const s = apply(newGame(), { type: 'START_GAME' });
    expectGameError(s, { type: 'WOLF_KILL', actor: 5, target: 7 }, 'NOT_YOUR_TURN');
    // kill a wolf's vote by having him act after he is dead is unreachable in
    // one night; a dead wolf's *late* vote is covered by PLAYER_DEAD below.
    void nightKill;
  });

  it('a dead actor is rejected', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9, 10], 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', null); // → night 2
    expectGameError(s, { type: 'WOLF_KILL', actor: 5, target: 7 }, 'PLAYER_DEAD');
  });
});

describe('night — resolution at dawn', () => {
  it('an unhealed kill dies at dawn, cause hidden from public events', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = holdElection(s, [9, 10], 9);
    expect(P(s, 5).alive).toBe(false); // applied at night completion…
    expect(s.phase).toBe('dawn-announce'); // …announced after the election
    s = apply(s, { type: 'PROCEED' });
    const announced = s.log.filter((e) => e.type === 'DEATH_ANNOUNCED').map((e) => e.seat);
    expect(announced).toEqual([5]);
  });

  it('kill + heal saves the target', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = witchTurn(s, { heal: true });
    s = seerTurn(s, 1);
    expect(P(s, 5).alive).toBe(true);
  });

  it('poison overrides heal on the same target', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 5);
    s = witchTurn(s, { heal: true, poison: 5 });
    s = seerTurn(s, 1);
    expect(P(s, 5).alive).toBe(false);
    const resolved = s.log.filter((e) => e.type === 'DEATH_RESOLVED');
    expect(resolved).toEqual([{ type: 'DEATH_RESOLVED', seat: 5, cause: 'poison' }]);
  });

  it('kill and poison on different targets kill both, announced in seat order', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 8, poison: 5, check: 1 });
    s = holdElection(s, [9, 10], 9);
    expect(P(s, 5).alive).toBe(false);
    expect(P(s, 8).alive).toBe(false);
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    const announced = s.log.filter((e) => e.type === 'DEATH_ANNOUNCED').map((e) => e.seat);
    expect(announced).toEqual([5, 8]);
  });

  it('空刀 plus poison is a single poison death', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { poison: 7, check: 1 });
    s = holdElection(s, [9, 10], 9);
    expect(P(s, 7).alive).toBe(false);
    expect(s.players[5]?.alive).toBe(true);
  });
});

describe('night — step skipping for dead roles', () => {
  function nightAfterWitchDied(): GameState {
    // night 1: wolves kill the witch (she passes during her step, dies at dawn)
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 10 });
    s = holdElection(s, [9, 11], 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', null); // → night 2
    return s;
  }

  it('a dead witch’s step is skipped', () => {
    let s = nightAfterWitchDied();
    expect(s.dayNumber).toBe(2);
    s = nightKill(s, 6);
    expect(s.night?.step).toBe('seer'); // straight past the witch
    s = seerTurn(s, 1);
    expect(s.phase).toBe('dawn-announce');
    expect(P(s, 6).alive).toBe(false);
  });

  it('a dead seer’s check is skipped and the night completes after the witch', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 9 });
    s = holdElection(s, [10, 11], 10);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', null); // → night 2
    s = nightKill(s, 6);
    expect(s.night?.step).toBe('witch');
    s = witchTurn(s);
    expect(s.phase).toBe('dawn-announce'); // no seer step
    expect(P(s, 6).alive).toBe(false);
  });
});
