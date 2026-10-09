import { describe, expect, it } from 'vitest';
import {
  apply,
  baseGame,
  holdElection,
  newGame,
  openDay,
  P,
  runNight,
  speechRound,
  voteAll,
} from './harness';

describe('full scripted game — good win through every interrupt', () => {
  it('passes through the idiot reveal, hunter shot, and badge pass to a good win', () => {
    let s = baseGame();

    // Day 1 — the village exiles the idiot: reveal, survive, lose the vote.
    s = voteAll(s, 'EXILE_VOTE', 12);
    expect(s.log.some((e) => e.type === 'IDIOT_REVEALED')).toBe(true);
    expect(P(s, 12).alive).toBe(true);
    expect(s.phase).toBe('night');

    // Night 2 — the wolves kill the witch. Day 2 opens without last words.
    s = runNight(s, { kill: 10 });
    s = openDay(s);
    expect(s.phase).toBe('exile-vote');

    // Day 2 — the hunter is exiled and shoots wolf 1.
    s = voteAll(s, 'EXILE_VOTE', 11);
    expect(s.phase).toBe('hunter-shot');
    s = apply(s, { type: 'HUNTER_SHOOT', actor: 11, target: 1 });
    expect(P(s, 1).alive).toBe(false);
    expect(s.phase).toBe('night');

    // Night 3 — the wolves kill the seer-sheriff; the badge passes to the revealed idiot.
    s = runNight(s, { kill: 9 });
    s = apply(s, { type: 'PROCEED' }); // announce seat 9
    expect(s.phase).toBe('badge-pass');
    s = apply(s, { type: 'SHERIFF_PASS', actor: 9, target: 12 });
    expect(P(s, 12).hasBadge).toBe(true);
    expect(s.phase).toBe('speech'); // night-3 deaths have no last words

    // Day 3 — the idiot-sheriff sets direction; the village exiles wolf 2.
    s = speechRound(s, { speeches: { 12: 'the seer’s checks are safe with me' } });
    s = voteAll(s, 'EXILE_VOTE', 2);
    expect(s.phase).toBe('night');

    // Night 4 — wolves kill a villager. Day 4 exiles wolf 3.
    s = runNight(s, { kill: 8 });
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 3);
    expect(s.phase).toBe('night');

    // Night 5 — wolves kill another villager. Day 5 exiles the last wolf.
    s = runNight(s, { kill: 7 });
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 4);
    expect(s.winner).toBe('good');
    expect(s.phase).toBe('game-over');
    expect(s.log.some((e) => e.type === 'IDIOT_REVEALED')).toBe(true);
    expect(s.log.some((e) => e.type === 'HUNTER_SHOT')).toBe(true);
    expect(s.log.some((e) => e.type === 'BADGE_PASSED')).toBe(true);
  });

  it('a full wolf win: the village abstains into oblivion (屠边 on villagers)', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5, check: 1 });
    s = holdElection(s, [9, 10], 9);
    s = openDay(s);
    for (const target of [6, 7]) {
      s = voteAll(s, 'EXILE_VOTE', null);
      s = runNight(s, { kill: target });
      s = openDay(s);
    }
    s = voteAll(s, 'EXILE_VOTE', null);
    s = runNight(s, { kill: 8 });
    expect(s.winner).toBe('wolves');
    expect(s.phase).toBe('game-over');
  });

  it('a spectator-free lobby start reaches night 1 with a fresh day counter', () => {
    let s = newGame();
    s = apply(s, { type: 'START_GAME' });
    expect(s.dayNumber).toBe(1);
    expect(s.night?.step).toBe('wolf');
    expect(s.night?.killTarget).toBeNull();
    expect(s.winner).toBeNull();
  });
});
