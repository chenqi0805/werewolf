import { describe, expect, it } from 'vitest';
import type { GameState } from '../index';
import { visibilityOf } from '../events';
import { applyDeath, winCheck } from '../resolution';
import {
  apply,
  expectGameError,
  holdElection,
  openDay,
  P,
  throughDayOpen,
  voteAll,
} from './harness';
import { newWolfKingGame, nightKillWK, runNightWK } from './wolfking-harness';

/** Quiet night 1, void election, day opened through the dawn → speech, cursor at slot 1. */
function toSpeech(): GameState {
  let s = apply(newWolfKingGame(), { type: 'START_GAME' });
  s = runNightWK(s, {});
  s = holdElection(s, [], null);
  return throughDayOpen(s);
}

/** Exiles the 白狼王: quiet night, void election, day open, unanimous vote on seat 4. */
function toKingExile(): GameState {
  let s = apply(newWolfKingGame(), { type: 'START_GAME' });
  s = runNightWK(s, {});
  s = holdElection(s, [], null);
  s = openDay(s);
  return voteAll(s, 'EXILE_VOTE', 4);
}

describe('白狼王 self-destruct — mid-speech', () => {
  it('kills the king and his target and ends the day into night', () => {
    const s = toSpeech();
    const s2 = apply(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 });
    expect(
      s2.log.some(
        (e) => e.type === 'WHITE_WOLF_KING_DESTRUCTED' && e.actor === 4 && e.target === 9,
      ),
    ).toBe(true);
    expect(P(s2, 4).alive).toBe(false);
    expect(P(s2, 9).alive).toBe(false);
    // The day ends immediately — night falls, the speech round is abandoned.
    expect(s2.phase).toBe('night');
    expect(s2.dayNumber).toBe(2);
    expect(s2.speech).toBeNull();
  });

  it('is single-use even before death takes him', () => {
    const s = toSpeech();
    const king = P(s, 4);
    if (king.private.kind !== 'white_wolf_king') throw new Error('deal drift');
    king.private.destructUsed = true;
    expectGameError(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 }, 'ALREADY_DONE');
  });

  it('fires only in the speech windows', () => {
    let s = apply(newWolfKingGame(), { type: 'START_GAME' });
    s = runNightWK(s, {});
    s = holdElection(s, [], null);
    s = openDay(s); // → exile-vote
    expectGameError(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 }, 'WRONG_PHASE');
    // Void vote → night 2 → quiet night → dawn announce, still no window.
    s = voteAll(s, 'EXILE_VOTE', null);
    s = runNightWK(s, {});
    expect(s.phase).toBe('dawn-announce');
    expectGameError(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 }, 'WRONG_PHASE');
  });

  it('rejects non-kings and self-targets', () => {
    const s = toSpeech();
    expectGameError(s, { type: 'WOLF_KING_DESTRUCT', actor: 5, target: 9 }, 'NOT_YOUR_TURN');
    expectGameError(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 4 }, 'INVALID_TARGET');
  });

  it('the hunter he takes can still shoot', () => {
    const s = toSpeech();
    const s2 = apply(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 11 });
    // The hunter's window opens inside the same settlement.
    expect(s2.phase).toBe('hunter-shot');
    const s3 = apply(s2, { type: 'HUNTER_SHOOT', actor: 11, target: 1 });
    expect(P(s3, 1).alive).toBe(false);
    // Then the day still ends into night.
    expect(s3.phase).toBe('night');
    expect(s3.dayNumber).toBe(2);
  });

  it('gives no last words to the king or his target', () => {
    const s = toSpeech();
    const s2 = apply(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 });
    expect(s2.phase).toBe('night');
    expect(s2.log.some((e) => e.type === 'SPEECH_MADE' && e.context === 'last-words')).toBe(false);
  });

  it('the badge still passes below the swallow threshold', () => {
    const s = toSpeech();
    const king = P(s, 4);
    if (king.private.kind !== 'white_wolf_king') throw new Error('deal drift');
    king.hasBadge = true;
    // Default 吞警徽 threshold is 2; this is only the first destruct.
    const s2 = apply(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 });
    expect(s2.phase).toBe('badge-pass');
    const s3 = apply(s2, { type: 'SHERIFF_PASS', actor: 4, target: 5 });
    expect(P(s3, 5).hasBadge).toBe(true);
    expect(s3.phase).toBe('night');
  });

  it('双爆吞警徽 destroys the badge at the configured destruct', () => {
    let s = apply(newWolfKingGame({ destructBadgeSwallow: 1 }), { type: 'START_GAME' });
    s = runNightWK(s, {});
    s = holdElection(s, [], null);
    s = throughDayOpen(s);
    const king = P(s, 4);
    if (king.private.kind !== 'white_wolf_king') throw new Error('deal drift');
    king.hasBadge = true;
    const s2 = apply(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 });
    // The badge is destroyed outright — no badge-pass window opens.
    expect(s2.phase).toBe('night');
    expect(s2.log.some((e) => e.type === 'BADGE_DESTROYED')).toBe(true);
    expect(P(s2, 4).hasBadge).toBe(false);
  });
});

describe('白狼王 self-destruct — exile settlement', () => {
  it('his settlement opens the destruct window', () => {
    const s = toKingExile();
    expect(P(s, 4).alive).toBe(false);
    expect(s.phase).toBe('hunter-shot');
    expect(s.resolution?.queue[0]?.destructWindow).toBe(true);
    const s2 = apply(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 });
    expect(P(s2, 9).alive).toBe(false);
    expect(s2.phase).toBe('night');
  });

  it('he may go quietly', () => {
    const s = toKingExile();
    const s2 = apply(s, { type: 'WOLF_KING_PASS', actor: 4 });
    expect(s2.log.some((e) => e.type === 'WOLF_KING_PASSED')).toBe(true);
    expect(s2.phase).toBe('night');
    expect(P(s2, 9).alive).toBe(true);
  });

  it('poison and the night kill open no window', () => {
    // Night-kill the king: night deaths never carry a destruct window.
    let s = apply(newWolfKingGame(), { type: 'START_GAME' });
    s = runNightWK(s, { kill: 4 });
    expect(s.phase).toBe('sheriff-signup');
    expect(s.pendingDawn?.some((r) => r.destructWindow)).toBe(false);
  });
});

describe('白狼王 in every wolf-literal site', () => {
  it('the seer reads the king as a wolf', () => {
    const s = apply(newWolfKingGame(), { type: 'START_GAME' });
    const s2 = runNightWK(s, { check: 4 });
    const seer = P(s2, 9);
    if (seer.private.kind !== 'seer') throw new Error('deal drift');
    expect(seer.private.checks[4]).toBe('wolf');
  });

  it('good wins only when the king is dead too', () => {
    const s = newWolfKingGame();
    for (const seat of [1, 2, 3] as const) applyDeath(s, seat, 'wolf-kill', []);
    // All wolves dead, but the wolf camp is not — the game continues.
    expect(winCheck(s)).toBeNull();
    applyDeath(s, 4, 'shot', []);
    expect(winCheck(s)).toBe('good');
  });

  it('the king votes in the wolf kill', () => {
    let s = apply(newWolfKingGame(), { type: 'START_GAME' });
    s = apply(s, { type: 'GUARD_PASS', actor: 12 });
    const s2 = nightKillWK(s, 5);
    // His ballot counted alongside the three wolves: the knife lands.
    expect(s2.night?.killTarget).toBe(5);
  });
});

describe('白狼王 events and windows', () => {
  it('the destruct announcement is public', () => {
    const s = toSpeech();
    const s2 = apply(s, { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 });
    const destructed = s2.log.find((e) => e.type === 'WHITE_WOLF_KING_DESTRUCTED');
    expect(destructed).toBeDefined();
    expect(visibilityOf(destructed!)).toEqual({ kind: 'public' });
  });

  it('death records carry destruct windows only for an unspent exiled king', () => {
    const s = newWolfKingGame();
    const king = P(s, 4);
    if (king.private.kind !== 'white_wolf_king') throw new Error('deal drift');
    expect(applyDeath(s, 4, 'exile', []).destructWindow).toBe(true);
    // Revive between causes — the unit probes record construction, not life.
    king.alive = true;
    expect(applyDeath(s, 4, 'wolf-kill', []).destructWindow).toBe(false);
    king.alive = true;
    expect(applyDeath(s, 4, 'poison', []).destructWindow).toBe(false);
    king.alive = true;
    expect(applyDeath(s, 4, 'shot', []).destructWindow).toBe(false);
    // Once spent, even the exile settlement stays closed.
    king.alive = true;
    king.private.destructUsed = true;
    expect(applyDeath(s, 4, 'exile', []).destructWindow).toBe(false);
  });

  it('self-destruct deaths never qualify for last words by default', () => {
    const s = newWolfKingGame();
    expect(applyDeath(s, 4, 'self-destruct', []).lastWordsEligible).toBe(false);
  });
});
