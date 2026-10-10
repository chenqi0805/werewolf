import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../index';
import {
  P,
  apply,
  expectGameError,
  holdElection,
  newGame,
  openDay,
  runNight,
  speechRound,
  throughDayOpen,
  voteAll,
} from './harness';
import { newWolfKingGame, runNightWK } from './wolfking-harness';

/** Index of the first log entry matching an event type (and predicate if given). */
function at(
  s: { log: GameEvent[] },
  type: GameEvent['type'],
  pick?: (e: GameEvent) => boolean,
): number {
  return s.log.findIndex((e) => e.type === type && (pick ? pick(e) : true));
}

/** Seat-9/10 tie the sheriff ballot into PK speeches (the sheriff.test.ts flow). */
function toPkSpeech(state: ReturnType<typeof newGame>): ReturnType<typeof newGame> {
  let s = apply(state, { type: 'SHERIFF_SIGNUP', actor: 9 });
  s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 10 });
  s = apply(s, { type: 'PROCEED' }); // close signup
  s = apply(s, { type: 'PROCEED' }); // 9 speaks
  s = apply(s, { type: 'PROCEED' }); // 10 speaks
  expect(s.phase).toBe('sheriff-vote');
  for (const [actor, target] of [
    [1, 9],
    [2, 9],
    [3, 10],
    [4, 10],
  ] as Array<[number, number]>) {
    s = apply(s, { type: 'SHERIFF_VOTE', actor, target });
  }
  for (const v of s.vote?.electorate ?? []) {
    if (![1, 2, 3, 4].includes(v)) s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: null });
  }
  expect(s.phase).toBe('pk-speech');
  return s;
}

describe('wolf explode — legality windows', () => {
  it('explodes during the day-1 signup window: election dies, buffered deaths release, night falls', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    expect(s.phase).toBe('sheriff-signup');
    expect(s.pendingDawn).not.toBeNull();
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 1 });

    // The exploder is dead and public — through WOLF_EXPLODED, not DEATH_ANNOUNCED.
    expect(P(s, 1).alive).toBe(false);
    expect(s.election).toBeNull();
    expect(s.pendingDawn).toBeNull();
    expect(s.phase).toBe('dawn-announce');
    const exploded = at(s, 'WOLF_EXPLODED');
    const broke = at(s, 'DAY_BROKE');
    expect(exploded).toBeGreaterThan(-1);
    expect(broke).toBeGreaterThan(exploded);
    expect(at(s, 'DEATH_ANNOUNCED')).toBe(-1);
    // A second wolf cannot interleave into the explosion's settlement.
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 2 }, 'WRONG_PHASE');

    // The release: PROCEED announces the buffered death, then night — no
    // last words (首夜遗言 belongs to the day program), no speeches.
    s = apply(s, { type: 'PROCEED' });
    const announced = at(s, 'DEATH_ANNOUNCED', (e) => e.type === 'DEATH_ANNOUNCED' && e.seat === 5);
    const night = at(s, 'NIGHT_BEGAN', (e) => e.type === 'NIGHT_BEGAN' && e.dayNumber === 2);
    expect(announced).toBeGreaterThan(broke);
    expect(night).toBeGreaterThan(announced);
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(2);
    expect(s.lastWords).toBeNull();
    expect(s.dawn).toBeNull();
    expect(at(s, 'SPEECH_MADE')).toBe(-1);
  });

  it('explodes mid candidate speech on day 1', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' }); // close signup
    expect(s.phase).toBe('sheriff-speech');
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 2 });
    expect(P(s, 2).alive).toBe(false);
    expect(s.election).toBeNull();
    expect(s.phase).toBe('dawn-announce');
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(2);
  });

  it('explodes during the election PK speeches', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = toPkSpeech(s);
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 3 });
    expect(P(s, 3).alive).toBe(false);
    expect(s.election).toBeNull();
    expect(s.phase).toBe('dawn-announce');
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('night');
    expect(s.pk).toBeNull();
  });

  it('explodes during a later-day speech round and goes straight to night', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = holdElection(s, [9], 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', null); // void ballot → night 2
    s = runNight(s, { kill: 6 });
    s = throughDayOpen(s);
    expect(s.phase).toBe('speech');
    const logBefore = s.log.length;
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 1 });
    expect(P(s, 1).alive).toBe(false);
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(3);
    // The day's deaths were announced at dawn — the explode adds none.
    expect(s.log.slice(logBefore).some((e) => e.type === 'DEATH_ANNOUNCED')).toBe(false);
    expect(s.log[logBefore]).toMatchObject({ type: 'WOLF_EXPLODED', seat: 1 });
  });

  it('on day 1 after the election, the explode goes straight to night', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9], 9);
    s = throughDayOpen(s);
    expect(s.phase).toBe('speech');
    // Sheriff 9 sets the direction; the explode needs no speech slot.
    s = apply(s, { type: 'SET_SPEECH_DIRECTION', actor: 9, direction: 'cw' });
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 2 });
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(2);
    expect(at(s, 'DEATH_ANNOUNCED')).toBeGreaterThan(-1); // seat 5, at dawn
  });
});

describe('wolf explode — refusals', () => {
  it('every ballot phase and the night refuse the explode', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('sheriff-vote');
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 1 }, 'WRONG_PHASE');
    expect(s.phase).toBe('sheriff-vote');
    expect(s.vote?.kind).toBe('sheriff');
    s = voteAll(s, 'SHERIFF_VOTE', 9); // elect 9 → the dawn releases
    s = throughDayOpen(s);
    s = speechRound(s);
    expect(s.phase).toBe('exile-vote');
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 1 }, 'WRONG_PHASE');

    // pk-vote: tie the ballot in a fresh game, run the PK speeches, refuse at
    // the revote.
    let pk = apply(newGame(), { type: 'START_GAME' });
    pk = runNight(pk, { kill: 5 });
    pk = toPkSpeech(pk);
    pk = apply(pk, { type: 'PROCEED' });
    pk = apply(pk, { type: 'PROCEED' });
    expect(pk.phase).toBe('pk-vote');
    expectGameError(pk, { type: 'WOLF_EXPLODE', actor: 1 }, 'WRONG_PHASE');
    expect(pk.vote?.kind).toBe('sheriff');

    s = voteAll(s, 'EXILE_VOTE', null);
    expect(s.phase).toBe('night');
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 1 }, 'WRONG_PHASE');
  });

  it('only plain wolves explode — gods, villagers, the 白狼王, and the dead are refused', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 6 }, 'NOT_YOUR_TURN'); // villager
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 9 }, 'NOT_YOUR_TURN'); // seer
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 11 }, 'NOT_YOUR_TURN'); // hunter
    // The 白狼王 keeps only his targeted destruct — on the wolfking board.
    let wk = apply(newWolfKingGame(), { type: 'START_GAME' });
    wk = runNightWK(wk, { kill: 5 });
    expect(wk.phase).toBe('sheriff-signup');
    expectGameError(wk, { type: 'WOLF_EXPLODE', actor: 4 }, 'NOT_YOUR_TURN'); // 白狼王
    wk = apply(wk, { type: 'WOLF_EXPLODE', actor: 1 }); // his plain packmate explodes
    expect(P(wk, 1).alive).toBe(false);
    expect(wk.phase).toBe('dawn-announce');
  });

  it('a dead wolf cannot explode', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9], 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 1); // exile wolf 1
    expect(P(s, 1).alive).toBe(false);
    s = runNight(s, { kill: 6 });
    s = throughDayOpen(s);
    expect(s.phase).toBe('speech');
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 1 }, 'PLAYER_DEAD');
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 2 }); // a living wolf still can
    expect(s.phase).toBe('night');
  });

  it('a rejected explode leaves the state untouched', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    const before = JSON.stringify(s);
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 5 }, 'PLAYER_DEAD'); // the night victim
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 9 }, 'NOT_YOUR_TURN'); // the seer
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('wolf explode — interrupts inside the release', () => {
  it('a night-dead hunter still fires inside the release', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 11 }); // the wolves take the hunter
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 1 });
    expect(s.phase).toBe('dawn-announce');
    s = apply(s, { type: 'PROCEED' }); // DEATH_ANNOUNCED(11)
    expect(s.phase).toBe('hunter-shot');
    s = apply(s, { type: 'HUNTER_SHOOT', actor: 11, target: 6 });
    expect(s.phase).toBe('night');
    const shot = at(s, 'HUNTER_SHOT');
    expect(shot).toBeGreaterThan(at(s, 'DEATH_ANNOUNCED', (e) => e.seat === 11));
    expect(at(s, 'NIGHT_BEGAN', (e) => e.dayNumber === 2)).toBeGreaterThan(shot);
    expect(at(s, 'SPEECH_MADE')).toBe(-1);
  });

  it('releases a peaceful night as 平安夜, then night falls', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: null }); // 空刀
    expect(s.phase).toBe('sheriff-signup');
    expect(s.pendingDawn).toEqual([]);
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 1 });
    expect(s.phase).toBe('dawn-announce');
    s = apply(s, { type: 'PROCEED' });
    expect(at(s, 'PEACEFUL_NIGHT')).toBeGreaterThan(-1);
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(2);
  });
});
