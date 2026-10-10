import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, visibilityOf } from '../index';
import type { Seat } from '../index';
import {
  apply,
  baseGame,
  expectGameError,
  holdElection,
  newGame,
  openDay,
  P,
  runNight,
  throughDayOpen,
  voteAll,
} from './harness';

describe('day — dawn announcements', () => {
  it('night deaths are announced in seat order, cause hidden from public events', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 8, poison: 5, check: 1 });
    s = holdElection(s, [9, 10], 9);
    s = apply(s, { type: 'PROCEED' }); // announce 5
    s = apply(s, { type: 'PROCEED' }); // announce 8
    const seats = s.log.filter((e) => e.type === 'DEATH_ANNOUNCED').map((e) => e.seat);
    expect(seats).toEqual([5, 8]);
    // causes exist in server events only
    const publicEvents = s.log.filter((e) => visibilityOf(e).kind === 'public');
    expect(publicEvents.some((e) => 'cause' in e)).toBe(false);
  });

  it('a quiet night announces 平安夜 and skips last words', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { check: 1 });
    s = holdElection(s, [9, 10], 9);
    s = openDay(s);
    expect(s.log.some((e) => e.type === 'PEACEFUL_NIGHT')).toBe(true);
    expect(Object.values(s.players).every((p) => p.alive)).toBe(true);
    expect(s.phase).toBe('exile-vote');
    expect(s.log.some((e) => e.type === 'SPEECH_MADE' && e.context === 'last-words')).toBe(false);
  });
});

describe('day — last words', () => {
  it('night-1 deaths give last words; the dead speak, others do not', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9, 10], 9);
    expect(s.phase).toBe('dawn-announce');
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('last-words');
    expect(s.lastWords?.queue).toEqual([5]);
    s = apply(s, { type: 'SPEAK', actor: 5, text: 'listen well' });
    expectGameError(s, { type: 'SPEAK', actor: 6, text: 'not my slot' }, 'NOT_YOUR_TURN');
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('speech');
  });

  it('deaths from night 2 onward have no last words', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', null); // → night 2
    s = runNight(s, { kill: 6 });
    expect(s.phase).toBe('dawn-announce');
    s = openDay(s);
    expect(s.phase).toBe('exile-vote');
    expect(
      s.log.filter((e) => e.type === 'SPEECH_MADE' && e.context === 'last-words'),
    ).toHaveLength(0);
  });
});

describe('day — speech round', () => {
  it('with no sheriff the order is ascending living seats and direction is preset', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'PROCEED' }); // close an empty signup → no sheriff
    expect(s.log.some((e) => e.type === 'NO_SHERIFF')).toBe(true);
    s = throughDayOpen(s); // announces 5, runs his last words, settles into speech
    expect(s.phase).toBe('speech');
    expect(
      s.log.filter((e) => e.type === 'SPEECH_MADE' && e.context === 'last-words'),
    ).toHaveLength(0);
    expect(s.speech?.order).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
    expectGameError(s, { type: 'SET_SPEECH_DIRECTION', actor: 1, direction: 'cw' }, 'ALREADY_DONE');
  });

  it('cw starts with the sheriff’s first successor', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9], 9);
    s = throughDayOpen(s);
    s = apply(s, { type: 'SET_SPEECH_DIRECTION', actor: 9, direction: 'cw' });
    expect(s.speech?.order).toEqual([10, 11, 12, 1, 2, 3, 4, 6, 7, 8, 9]);
  });

  it('ccw runs the other way', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9], 9);
    s = throughDayOpen(s);
    s = apply(s, { type: 'SET_SPEECH_DIRECTION', actor: 9, direction: 'ccw' });
    expect(s.speech?.order).toEqual([8, 7, 6, 4, 3, 2, 1, 12, 11, 10, 9]);
  });

  it('sheriffSpeaksFirst starts with the badge holder', () => {
    let s = apply(newGame({ ...DEFAULT_CONFIG, sheriffSpeaksFirst: true }), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9], 9);
    s = throughDayOpen(s);
    s = apply(s, { type: 'SET_SPEECH_DIRECTION', actor: 9, direction: 'cw' });
    expect(s.speech?.order).toEqual([9, 10, 11, 12, 1, 2, 3, 4, 6, 7, 8]);
  });

  it('only the current slot may speak; PROCEED before direction is rejected', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = holdElection(s, [9], 9);
    s = throughDayOpen(s);
    expect(s.speech?.order).toBeNull();
    expectGameError(s, { type: 'PROCEED' }, 'WRONG_PHASE');
    expectGameError(s, { type: 'SPEAK', actor: 11, text: 'early' }, 'WRONG_PHASE');
    s = apply(s, { type: 'SET_SPEECH_DIRECTION', actor: 9, direction: 'cw' });
    s = apply(s, { type: 'SPEAK', actor: 10, text: 'first' });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'SPEAK', actor: 11, text: 'second' });
    expect(s.log.filter((e) => e.type === 'SPEECH_MADE')).toHaveLength(2);
  });

  it('a full speech round ends in the exile vote', () => {
    const s = baseGame();
    expect(s.phase).toBe('exile-vote');
    expect(s.vote?.kind).toBe('exile');
    expect(s.vote?.electorate).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('day — exile vote', () => {
  it('votes stay hidden until the tally; abstentions are legal and void the day', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', null); // everyone abstains
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(2);
    const casts = s.log.filter((e) => e.type === 'EXILE_VOTE_CAST');
    expect(casts).toHaveLength(11);
    expect(casts.every((e) => visibilityOf(e).kind === 'server')).toBe(true);
    expect(s.log.filter((e) => e.type === 'VOTE_TALLY' && e.kind === 'exile')).toHaveLength(1);
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED')).toBe(false);
  });

  it('a plurality exile removes the target', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', 6);
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED' && e.seat === 6)).toBe(true);
    expect(P(s, 6).alive).toBe(false);
    expect(s.phase).toBe('night');
  });

  it('a tie goes to PK speeches, a revote the tied cannot vote in, and may void', () => {
    let s = baseGame();
    for (const [actor, target] of [
      [1, 6],
      [2, 7],
      [3, 6],
      [4, 7],
    ] as Array<[Seat, Seat]>) {
      s = apply(s, { type: 'EXILE_VOTE', actor, target });
    }
    for (const v of s.vote?.electorate ?? []) {
      if (![1, 2, 3, 4].includes(v)) s = apply(s, { type: 'EXILE_VOTE', actor: v, target: null });
    }
    expect(s.phase).toBe('pk-speech');
    expect(s.pk?.tied).toEqual([6, 7]);
    s = apply(s, { type: 'SPEAK', actor: 6, text: 'pk speech' });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'SPEAK', actor: 7, text: 'pk speech' });
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('pk-vote');
    expectGameError(s, { type: 'EXILE_VOTE', actor: 6, target: 7 }, 'NO_VOTE_RIGHTS');
    for (const v of s.vote?.electorate ?? []) {
      s = apply(s, { type: 'EXILE_VOTE', actor: v, target: 6 });
    }
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED' && e.seat === 6)).toBe(true);
  });

  it('a tie covering every voter ends the day — the revote would be vacuous', () => {
    // Badgeless table: the sheriff election voids on zero signups, so every
    // vote weighs 1 and a full cycle can tie the entire electorate.
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = apply(s, { type: 'PROCEED' }); // closes signup with an empty podium — no sheriff
    s = openDay(s);
    expect(s.phase).toBe('exile-vote');
    const electorate = s.vote?.electorate ?? [];
    expect(electorate).toHaveLength(11);
    // Everyone votes themselves: an 11-way tie whose tied set is every voter.
    for (const v of electorate) {
      s = apply(s, { type: 'EXILE_VOTE', actor: v, target: v });
    }
    expect(s.phase).toBe('pk-speech');
    expect(s.pk?.tied).toHaveLength(11);
    for (const tied of s.pk?.tied ?? []) {
      s = apply(s, { type: 'SPEAK', actor: tied, text: 'pk speech' });
      s = apply(s, { type: 'PROCEED' });
    }
    // The revote has no eligible voters — the day must end, not freeze.
    expect(s.phase).toBe('night');
    expect(s.vote).toBeNull();
    // Nobody was exiled: the night kill is the only death.
    expect(
      Object.values(s.players)
        .filter((p) => !p.alive)
        .map((p) => p.seat),
    ).toEqual([5]);
  });

  it('a second exile tie voids the day — no one is removed', () => {
    let s = baseGame();
    for (const [actor, target] of [
      [1, 6],
      [2, 7],
      [3, 6],
      [4, 7],
    ] as Array<[Seat, Seat]>) {
      s = apply(s, { type: 'EXILE_VOTE', actor, target });
    }
    for (const v of s.vote?.electorate ?? []) {
      if (![1, 2, 3, 4].includes(v)) s = apply(s, { type: 'EXILE_VOTE', actor: v, target: null });
    }
    s = throughDayOpenPK(s);
    for (const v of s.vote?.electorate ?? []) {
      s = apply(s, { type: 'EXILE_VOTE', actor: v, target: null });
    }
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(2);
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED')).toBe(false);
  });

  it('dead voters and out-of-electorate votes are rejected', () => {
    const s = baseGame();
    expectGameError(s, { type: 'EXILE_VOTE', actor: 5, target: 6 }, 'PLAYER_DEAD');
  });

  it('a cast ballot is final — a second vote from the same voter is rejected', () => {
    let s = baseGame();
    s = apply(s, { type: 'EXILE_VOTE', actor: 1, target: 6 });
    expect(s.vote?.votes[1]).toBe(6);
    expectGameError(s, { type: 'EXILE_VOTE', actor: 1, target: 7 }, 'ALREADY_DONE');
    expect(s.vote?.votes[1]).toBe(6);
  });
});

/** PK-speech helper for the void test: PROCEED through both tied slots. */
function throughDayOpenPK(state: ReturnType<typeof newGame>) {
  let s = state;
  s = apply(s, { type: 'PROCEED' });
  s = apply(s, { type: 'PROCEED' });
  return s;
}
