import { describe, expect, it } from 'vitest';
import type { Seat } from '../index';
import {
  apply,
  expectGameError,
  newGame,
  openDay,
  P,
  runNight,
  speechRound,
  throughDayOpen,
  voteAll,
} from './harness';

describe('sheriff — signup and speeches', () => {
  it('signup, close, speeches, and plurality elect the sheriff', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 10 });
    expectGameError(s, { type: 'SHERIFF_SIGNUP', actor: 9 }, 'ALREADY_DONE');
    s = apply(s, { type: 'PROCEED' }); // close signup
    expect(s.phase).toBe('sheriff-speech');
    s = apply(s, { type: 'PROCEED' }); // 9 speaks
    s = apply(s, { type: 'PROCEED' }); // 10 speaks
    expect(s.phase).toBe('sheriff-vote');
    // 警上 candidates cannot vote
    expectGameError(s, { type: 'SHERIFF_VOTE', actor: 9, target: 10 }, 'NO_VOTE_RIGHTS');
    s = voteAll(s, 'SHERIFF_VOTE', 10);
    expect(P(s, 10).hasBadge).toBe(true);
    expect(s.log.some((e) => e.type === 'SHERIFF_ELECTED' && e.seat === 10)).toBe(true);
  });

  it('a candidate may withdraw (退水) during signup and then vote as 警下', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 10 });
    s = apply(s, { type: 'SHERIFF_WITHDRAW', actor: 9 });
    expect(s.election?.candidates).toEqual([10]);
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('sheriff-vote');
    s = apply(s, { type: 'SHERIFF_VOTE', actor: 9, target: 10 }); // withdrew → 警下 → votes
    const rest = (s.vote?.electorate ?? []).filter((v) => v !== 9);
    for (const v of rest) s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: 10 });
    expect(P(s, 10).hasBadge).toBe(true);
  });

  it('withdrawing during candidate speeches shifts the queue', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 10 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 11 });
    s = apply(s, { type: 'PROCEED' }); // speeches: 9 → 10 → 11
    s = apply(s, { type: 'SHERIFF_WITHDRAW', actor: 10 }); // before his slot
    s = apply(s, { type: 'PROCEED' }); // 9
    s = apply(s, { type: 'PROCEED' }); // 11 — queue shifted up
    expect(s.phase).toBe('sheriff-vote');
  });

  it('if every candidate withdraws there is no sheriff', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'SHERIFF_WITHDRAW', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    expect(s.log.some((e) => e.type === 'NO_SHERIFF')).toBe(true);
    expect(s.phase).toBe('dawn-announce');
    expect(Object.values(s.players).every((p) => !p.hasBadge)).toBe(true);
  });

  it('dead players cannot sign up', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    expectGameError(s, { type: 'SHERIFF_SIGNUP', actor: 5 }, 'PLAYER_DEAD');
  });
});

describe('sheriff — votes, PK, and revote', () => {
  it('a tie sends the top two to PK speeches and a revote', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 10 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('sheriff-vote');
    // 警下: 1,2,3,4,6,7,8,11,12 — split 2–2, rest abstain
    for (const [actor, target] of [
      [1, 9],
      [2, 9],
      [3, 10],
      [4, 10],
    ] as Array<[Seat, Seat]>) {
      s = apply(s, { type: 'SHERIFF_VOTE', actor, target });
    }
    for (const v of s.vote?.electorate ?? []) {
      if (![1, 2, 3, 4].includes(v)) s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: null });
    }
    expect(s.phase).toBe('pk-speech');
    expect(s.pk?.tied).toEqual([9, 10]);
    s = apply(s, { type: 'PROCEED' }); // 9 PK-speeches
    s = apply(s, { type: 'PROCEED' }); // 10 PK-speeches
    expect(s.phase).toBe('pk-vote');
    // tied players may not vote in the revote
    expectGameError(s, { type: 'SHERIFF_VOTE', actor: 9, target: 10 }, 'NO_VOTE_RIGHTS');
    for (const v of s.vote?.electorate ?? []) {
      s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: 10 });
    }
    expect(P(s, 10).hasBadge).toBe(true);
  });

  it('a second tie voids the election — no sheriff this game', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 10 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    for (const [actor, target] of [
      [1, 9],
      [2, 9],
      [3, 10],
      [4, 10],
    ] as Array<[Seat, Seat]>) {
      s = apply(s, { type: 'SHERIFF_VOTE', actor, target });
    }
    for (const v of s.vote?.electorate ?? []) {
      if (![1, 2, 3, 4].includes(v)) s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: null });
    }
    expect(s.phase).toBe('pk-speech');
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    expect(s.phase).toBe('pk-vote');
    // the revote also ties 2–2 → the election is void
    for (const [actor, target] of [
      [1, 9],
      [2, 9],
      [3, 10],
      [4, 10],
    ] as Array<[Seat, Seat]>) {
      s = apply(s, { type: 'SHERIFF_VOTE', actor, target });
    }
    for (const v of s.vote?.electorate ?? []) {
      if (![1, 2, 3, 4].includes(v)) s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: null });
    }
    expect(s.log.some((e) => e.type === 'NO_SHERIFF')).toBe(true);
    expect(s.phase).toBe('dawn-announce');
    expect(Object.values(s.players).every((p) => !p.hasBadge)).toBe(true);
  });

  it('all-abstain ballots elect nobody and void without a PK', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'SHERIFF_VOTE', null);
    expect(s.log.some((e) => e.type === 'NO_SHERIFF')).toBe(true);
    expect(s.phase).toBe('dawn-announce');
  });
});

describe('sheriff — badge weight and transfer', () => {
  it('the sheriff’s 1.5 vote can decide the exile', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'SHERIFF_VOTE', 9);
    s = throughDayOpen(s);
    s = speechRound(s);
    // 1: sheriff 1.5 + own vote 1 = 2.5 — 2: votes 3,4 = 2. Without the badge: 1–1 tie → PK.
    s = apply(s, { type: 'EXILE_VOTE', actor: 9, target: 1 });
    s = apply(s, { type: 'EXILE_VOTE', actor: 1, target: 1 });
    s = apply(s, { type: 'EXILE_VOTE', actor: 2, target: 2 });
    s = apply(s, { type: 'EXILE_VOTE', actor: 3, target: 2 });
    for (const v of s.vote?.electorate ?? []) {
      if (![9, 1, 2, 3].includes(v)) s = apply(s, { type: 'EXILE_VOTE', actor: v, target: null });
    }
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED' && e.seat === 1)).toBe(true);
    expect(P(s, 1).alive).toBe(false);
    expect(s.phase).toBe('night');
  });

  it('the badge passes on death (移交) and the 1.5 weight moves with it', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'SHERIFF_VOTE', 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 9); // exile the sheriff
    expect(s.phase).toBe('badge-pass');
    s = apply(s, { type: 'SHERIFF_PASS', actor: 9, target: 10 });
    expect(P(s, 10).hasBadge).toBe(true);
    expect(P(s, 9).hasBadge).toBe(false);
    expect(s.phase).toBe('night');
  });

  it('the badge can be destroyed (撕毁)', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'SHERIFF_VOTE', 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 9);
    expect(s.phase).toBe('badge-pass');
    s = apply(s, { type: 'SHERIFF_PASS', actor: 9, target: null });
    expect(Object.values(s.players).every((p) => !p.hasBadge)).toBe(true);
    expect(s.phase).toBe('night');
  });

  it('only the departing holder may pass, and only to a living player', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'SHERIFF_VOTE', 9);
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 9);
    expect(s.phase).toBe('badge-pass');
    expectGameError(s, { type: 'SHERIFF_PASS', actor: 10, target: 12 }, 'NOT_YOUR_TURN');
    expectGameError(s, { type: 'SHERIFF_PASS', actor: 9, target: 5 }, 'PLAYER_DEAD'); // 5 dead
  });

  it('the election completes before night deaths are announced', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'SHERIFF_VOTE', 9);
    const elected = s.log.findIndex((e) => e.type === 'SHERIFF_ELECTED');
    expect(elected).toBeGreaterThan(-1);
    expect(s.phase).toBe('dawn-announce'); // deaths wait behind the badge
    expect(s.log.some((e) => e.type === 'DEATH_ANNOUNCED')).toBe(false);
    s = apply(s, { type: 'PROCEED' }); // now the night death is announced
    const announced = s.log.findIndex((e) => e.type === 'DEATH_ANNOUNCED');
    expect(announced).toBeGreaterThan(elected);
  });
});

describe('sheriff — explosion during the election (自爆)', () => {
  it('an explosion mid-campaign voids the election and releases the night deaths in order', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 9 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 10 });
    s = apply(s, { type: 'PROCEED' }); // candidate speeches
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 1 });

    // No sheriff is ever elected — platform, speeches, and ballot are void.
    expect(s.log.some((e) => e.type === 'SHERIFF_ELECTED')).toBe(false);
    expect(s.election).toBeNull();
    // Release order: explode → day breaks → (PROCEED) → announcements → night.
    const exploded = s.log.findIndex((e) => e.type === 'WOLF_EXPLODED');
    const broke = s.log.findIndex((e) => e.type === 'DAY_BROKE');
    expect(exploded).toBeGreaterThan(-1);
    expect(broke).toBeGreaterThan(exploded);
    s = apply(s, { type: 'PROCEED' });
    const announced = s.log.findIndex((e) => e.type === 'DEATH_ANNOUNCED' && e.seat === 5);
    const night = s.log.findIndex((e) => e.type === 'NIGHT_BEGAN' && e.dayNumber === 2);
    expect(announced).toBeGreaterThan(broke);
    expect(night).toBeGreaterThan(announced);
    expect(s.phase).toBe('night');
  });

  it('a wolf-sheriff exploding routes through the badge window before night', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    s = apply(s, { type: 'SHERIFF_SIGNUP', actor: 1 }); // the wolf runs
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'SHERIFF_VOTE', 1);
    expect(P(s, 1).hasBadge).toBe(true);
    s = throughDayOpen(s); // announcements + last words → speech round
    expect(s.phase).toBe('speech');
    s = apply(s, { type: 'SET_SPEECH_DIRECTION', actor: 1, direction: 'cw' });
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 1 });
    // The badge window opens on the explosion's own settlement — a plain
    // explode never swallows the badge (双爆吞警徽 stays the 白狼王's knob).
    expect(s.phase).toBe('badge-pass');
    expect(s.resolution?.queue[0]?.badgePass).toBe(true);
    // A second wolf cannot interleave into the open settlement.
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 2 }, 'WRONG_PHASE');
    s = apply(s, { type: 'SHERIFF_PASS', actor: 1, target: 2 });
    expect(P(s, 2).hasBadge).toBe(true);
    expect(s.phase).toBe('night');
    expect(s.dayNumber).toBe(2);
    const passed = s.log.findIndex((e) => e.type === 'BADGE_PASSED');
    const night = s.log.findIndex((e) => e.type === 'NIGHT_BEGAN' && e.dayNumber === 2);
    expect(passed).toBeGreaterThan(-1);
    expect(night).toBeGreaterThan(passed);
  });

  it('the win check fires exactly once when the last wolf explodes mid-speech', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    // Night 1: the wolves knife 5; the witch poisons wolf 2.
    s = runNight(s, { kill: 5, poison: 2 });
    // Day 1: the election voids (empty signup), the deaths release, wolf 3 exiled.
    s = apply(s, { type: 'PROCEED' });
    s = throughDayOpen(s);
    s = speechRound(s);
    s = voteAll(s, 'EXILE_VOTE', 3);
    expect(P(s, 3).alive).toBe(false);
    // Night 2: knife 6; day 2: wolf 4 exiled.
    s = runNight(s, { kill: 6 });
    s = throughDayOpen(s);
    s = speechRound(s);
    s = voteAll(s, 'EXILE_VOTE', 4);
    expect(P(s, 4).alive).toBe(false);
    // Night 3: 空刀; day 3: the last wolf explodes mid-speech — good wins.
    s = runNight(s, { kill: null });
    s = throughDayOpen(s);
    expect(s.phase).toBe('speech');
    s = apply(s, { type: 'WOLF_EXPLODE', actor: 1 });
    expect(s.winner).toBe('good');
    expect(s.phase).toBe('game-over');
    expect(s.log.filter((e) => e.type === 'GAME_OVER')).toHaveLength(1);
    expectGameError(s, { type: 'WOLF_EXPLODE', actor: 2 }, 'WRONG_PHASE'); // game over
  });
});
