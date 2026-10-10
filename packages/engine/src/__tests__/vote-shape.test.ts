import { describe, expect, it } from 'vitest';
import type { GameEvent, Seat } from '../index';
import { visibilityOf } from '../index';
import { apply, baseGame, newGame, runNight, voteAll } from './harness';

/** The log's tallies of one kind, in log order. */
function talliesOf(log: GameEvent[], kind: 'sheriff' | 'exile') {
  return log.filter(
    (e): e is Extract<GameEvent, { type: 'VOTE_TALLY' }> =>
      e.type === 'VOTE_TALLY' && e.kind === kind,
  );
}

/** Asserts exactly one tally of the kind and returns it. */
function onlyTally(log: GameEvent[], kind: 'sheriff' | 'exile') {
  const tallies = talliesOf(log, kind);
  expect(tallies, `one ${kind} VOTE_TALLY`).toHaveLength(1);
  return tallies[0]!;
}

describe('vote shape — ballots ride VOTE_TALLY, revealed only at the close', () => {
  it('nothing ballot-shaped exists before the close; the tally is public', () => {
    let s = baseGame();
    const electorate = s.vote?.electorate ?? [];
    for (const voter of electorate.slice(0, -1)) {
      s = apply(s, { type: 'EXILE_VOTE', actor: voter, target: 6 });
    }
    // In-progress ballots are server-only audit; no tally has been published.
    const casts = s.log.filter((e) => e.type === 'EXILE_VOTE_CAST');
    expect(casts).toHaveLength(electorate.length - 1);
    expect(casts.every((e) => visibilityOf(e).kind === 'server')).toBe(true);
    // baseGame's log already carries the day-1 election tally — the exile
    // round's own tally is what must not exist yet.
    expect(talliesOf(s.log, 'exile')).toHaveLength(0);

    const last = electorate[electorate.length - 1]!;
    s = apply(s, { type: 'EXILE_VOTE', actor: last, target: 6 });
    const tally = s.log.find((e) => e.type === 'VOTE_TALLY');
    expect(tally).toBeDefined();
    expect(visibilityOf(tally!).kind).toBe('public');
  });

  it('每日放逐: full ballots with the 1.5 badge weight, abstentions included', () => {
    // baseGame leaves the badge on 9; seat 5 died at night.
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', null); // everyone abstains → void day
    const tally = onlyTally(s.log, 'exile');
    expect(tally.revote).toBe(false);
    expect(tally.ballots).toEqual(
      [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12].map((voter) => ({
        voter,
        target: null,
        weight: voter === 9 ? 1.5 : 1,
      })),
    );
  });

  it('每日放逐: a plurality exile carries every ballot, voter-seat ascending', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', 6);
    const tally = onlyTally(s.log, 'exile');
    expect(tally.revote).toBe(false);
    expect(tally.ballots.map((b) => b.voter)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
    expect(tally.ballots.every((b) => b.target === 6)).toBe(true);
    expect(tally.ballots.find((b) => b.voter === 9)?.weight).toBe(1.5);
    expect(tally.ballots.filter((b) => b.voter !== 9).every((b) => b.weight === 1)).toBe(true);
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED' && e.seat === 6)).toBe(true);
  });

  it('警长竞选: the election tally names every 警下 voter, revote false', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    for (const c of [9, 10]) s = apply(s, { type: 'SHERIFF_SIGNUP', actor: c });
    s = apply(s, { type: 'PROCEED' }); // close signup
    s = apply(s, { type: 'PROCEED' }); // 9 speaks
    s = apply(s, { type: 'PROCEED' }); // 10 speaks
    s = voteAll(s, 'SHERIFF_VOTE', 10);
    const tally = onlyTally(s.log, 'sheriff');
    expect(tally.revote).toBe(false);
    // 警上 candidates never appear as voters; nobody holds the badge yet.
    expect(tally.ballots.map((b) => b.voter)).toEqual([1, 2, 3, 4, 6, 7, 8, 11, 12]);
    expect(tally.ballots.every((b) => b.weight === 1 && b.target === 10)).toBe(true);
  });

  it('警长PK: a tied election goes to a revote whose tally says revote', () => {
    let s = apply(newGame(), { type: 'START_GAME' });
    s = runNight(s, { kill: 5 });
    for (const c of [9, 10, 11]) s = apply(s, { type: 'SHERIFF_SIGNUP', actor: c });
    s = apply(s, { type: 'PROCEED' }); // close signup
    for (let i = 0; i < 3; i++) s = apply(s, { type: 'PROCEED' }); // speeches
    // Electorate of 8: a 4–4 tie between 9 and 10.
    for (const v of [1, 2, 3, 4]) s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: 9 });
    for (const v of [6, 7, 8, 12]) s = apply(s, { type: 'SHERIFF_VOTE', actor: v, target: 10 });
    expect(s.phase).toBe('pk-speech');
    expect(onlyTally(s.log, 'sheriff').revote).toBe(false);

    s = apply(s, { type: 'PROCEED' }); // 9 speaks
    s = apply(s, { type: 'PROCEED' }); // 10 speaks
    expect(s.phase).toBe('pk-vote');
    s = voteAll(s, 'SHERIFF_VOTE', 9);
    const tallies = talliesOf(s.log, 'sheriff');
    expect(tallies).toHaveLength(2);
    const second = tallies[1]!;
    expect(second.revote).toBe(true);
    expect(second.ballots.map((b) => b.voter)).toEqual([1, 2, 3, 4, 6, 7, 8, 12]);
    expect(s.log.some((e) => e.type === 'SHERIFF_ELECTED' && e.seat === 9)).toBe(true);
  });

  it('放逐PK: the revote electorate drops the tied seats and keeps badge weights', () => {
    let s = baseGame(); // badge on 9, seat 5 dead
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
    s = apply(s, { type: 'PROCEED' }); // 6 speaks
    s = apply(s, { type: 'PROCEED' }); // 7 speaks
    expect(s.phase).toBe('pk-vote');
    s = voteAll(s, 'EXILE_VOTE', 6);
    const tallies = talliesOf(s.log, 'exile');
    expect(tallies).toHaveLength(2);
    const revote = tallies[1]!;
    expect(revote.revote).toBe(true);
    // The tied seats 6 and 7 abstain by rule — they are not voters here.
    expect(revote.ballots.map((b) => b.voter)).toEqual([1, 2, 3, 4, 8, 9, 10, 11, 12]);
    expect(revote.ballots.find((b) => b.voter === 9)?.weight).toBe(1.5);
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED' && e.seat === 6)).toBe(true);
  });

  it('放逐PK: a second tie voids the day with a revote-labelled tally', () => {
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
    s = apply(s, { type: 'PROCEED' });
    s = apply(s, { type: 'PROCEED' });
    s = voteAll(s, 'EXILE_VOTE', null); // revote: everyone abstains → void
    const tallies = talliesOf(s.log, 'exile');
    expect(tallies).toHaveLength(2);
    const revote = tallies[1]!;
    expect(revote.revote).toBe(true);
    expect(revote.ballots.every((b) => b.target === null)).toBe(true);
    expect(s.log.some((e) => e.type === 'PLAYER_EXILED')).toBe(false);
    expect(s.phase).toBe('night');
  });
});
