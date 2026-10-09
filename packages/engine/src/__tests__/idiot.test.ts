import { describe, expect, it } from 'vitest';
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

describe('idiot — reveal by exile vote', () => {
  it('exiling the idiot reveals him; he survives the day and loses his vote', () => {
    let s = baseGame();
    // the unrevealed idiot can still vote
    s = apply(s, { type: 'EXILE_VOTE', actor: 12, target: 10 });
    // everyone else exiles him
    s = voteAll(s, 'EXILE_VOTE', 12, [1, 2, 3, 4, 6, 7, 8, 9, 10, 11]);
    expect(s.log.some((e) => e.type === 'IDIOT_REVEALED' && e.seat === 12)).toBe(true);
    expect(P(s, 12).alive).toBe(true);
    expect(P(s, 12).revealedIdiot).toBe(true);
    expect(s.dayNumber).toBe(2); // the reveal consumed the day — no one died
    expect(s.phase).toBe('night');
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED')).toBe(false);
  });

  it('a revealed idiot cannot be exiled again — the vote removes nobody', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', 12); // reveal him first
    s = runNight(s, { kill: 6 }); // night 2
    s = openDay(s);
    expect(s.phase).toBe('exile-vote');
    expect(s.vote?.electorate).not.toContain(12);
    s = voteAll(s, 'EXILE_VOTE', 12); // the vote lands on him again
    expect(s.log.some((e) => e.type === 'EXILE_BLOCKED_BY_IDIOT' && e.seat === 12)).toBe(true);
    expect(P(s, 12).alive).toBe(true);
    expect(s.dayNumber).toBe(3);
    expect(s.phase).toBe('night');
  });

  it('a revealed idiot cannot vote and still speaks', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', 12);
    s = runNight(s, { kill: 6 });
    s = openDay(s);
    expectGameError(s, { type: 'EXILE_VOTE', actor: 12, target: 10 }, 'NO_VOTE_RIGHTS');
    s = voteAll(s, 'EXILE_VOTE', null); // void day 2 → night 3
    s = runNight(s, { kill: 7 });
    s = openDay(s, { speeches: { 12: 'revealed, but I still speak' } });
    expect(
      s.log.some((e) => e.type === 'SPEECH_MADE' && e.seat === 12 && e.context === 'speech'),
    ).toBe(true);
  });
});

describe('idiot — death by everything else', () => {
  it('dies to the wolf kill without revealing', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, 12);
    s = witchTurn(s);
    s = seerTurn(s, 1);
    s = holdElection(s, [9, 10], 9);
    s = openDay(s);
    expect(P(s, 12).alive).toBe(false);
    expect(P(s, 12).revealedIdiot).toBe(false);
    expect(s.log.some((e) => e.type === 'IDIOT_REVEALED')).toBe(false);
  });

  it('dies to poison', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = nightKill(s, null);
    s = witchTurn(s, { poison: 12 });
    s = seerTurn(s, 1);
    s = holdElection(s, [9, 10], 9);
    s = openDay(s);
    expect(P(s, 12).alive).toBe(false);
  });

  it('dies to the hunter shot', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', 11); // exile the hunter
    expect(s.phase).toBe('hunter-shot');
    s = apply(s, { type: 'HUNTER_SHOOT', actor: 11, target: 12 });
    expect(P(s, 12).alive).toBe(false);
    expect(s.phase).toBe('night');
  });
});
