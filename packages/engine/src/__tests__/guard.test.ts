import { describe, expect, it } from 'vitest';
import type { GameState } from '../index';
import { visibilityOf } from '../events';
import { winCheck } from '../resolution';
import {
  apply,
  expectGameError,
  holdElection,
  newGame,
  nightKill,
  openDay,
  P,
  seerTurn,
  witchTurn,
} from './harness';
import { newWolfKingGame, nightKillWK, runNightWK, toNextNight } from './wolfking-harness';

describe('guard night step', () => {
  it('wakes first on the wolfking board and gates the wolves', () => {
    const s = apply(newWolfKingGame(), { type: 'START_GAME' });
    expect(s.phase).toBe('night');
    expect(s.night?.guardTurn).toBe('pending');
    // No wolf may vote while the guard's turn is open.
    expectGameError(s, { type: 'WOLF_KILL', actor: 1, target: 5 }, 'NOT_YOUR_TURN');
    const s2 = apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 5 });
    expect(s2.night?.guardTurn).toBe('done');
    expect(s2.night?.protectTarget).toBe(5);
    const s3 = nightKillWK(s2, 6);
    expect(s3.night?.killTarget).toBe(6);
  });

  it('keeps the classic night shape — no guard turn anywhere', () => {
    const s = apply(newGame(), { type: 'START_GAME' });
    expect(s.night?.guardTurn).toBeNull();
    expect(s.night?.protectTarget).toBeNull();
    // The classic first night starts straight at the wolf step.
    const s2 = nightKill(s, 5);
    expect(s2.night?.killTarget).toBe(5);
  });

  it('resolves the kill only when every wolf-camp seat has voted', () => {
    let s: GameState = apply(newWolfKingGame(), { type: 'START_GAME' });
    s = apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 9 });
    s = apply(s, { type: 'WOLF_KILL', actor: 1, target: 5 });
    expect(s.night?.killTarget).toBeNull();
    s = apply(s, { type: 'WOLF_KILL', actor: 2, target: 5 });
    s = apply(s, { type: 'WOLF_KILL', actor: 3, target: 5 });
    expect(s.night?.killTarget).toBeNull(); // 白狼王 (seat 4) has not voted yet
    const s2 = apply(s, { type: 'WOLF_KILL', actor: 4, target: 5 });
    expect(s2.night?.killTarget).toBe(5);
  });

  it('protection turns the knife — 平安夜 with no deaths', () => {
    const s = runNightWK(apply(newWolfKingGame(), { type: 'START_GAME' }), {
      guard: 5,
      kill: 5,
    });
    expect(s.pendingDawn).toEqual([]);
    // Day 1 announces the dawn only after the election.
    const s2 = openDay(holdElection(s, [], null));
    expect(s2.log.some((e) => e.type === 'PEACEFUL_NIGHT')).toBe(true);
  });

  it('自守 protects the guard himself', () => {
    const s = runNightWK(apply(newWolfKingGame(), { type: 'START_GAME' }), {
      guard: 12,
      kill: 12,
    });
    expect(s.pendingDawn).toEqual([]);
  });

  it('空守 (pass) lets the knife land', () => {
    const s = runNightWK(apply(newWolfKingGame(), { type: 'START_GAME' }), {
      guard: null,
      kill: 5,
    });
    expect(s.pendingDawn?.map((r) => r.seat)).toEqual([5]);
  });

  it('protection holds while the witch poisons someone else', () => {
    const s = runNightWK(apply(newWolfKingGame(), { type: 'START_GAME' }), {
      guard: 5,
      kill: 5,
      poison: 8,
    });
    // 5 survives the guarded knife; 8 dies of poison.
    expect(s.pendingDawn?.map((r) => r.seat)).toEqual([8]);
  });
});

describe('守卫 knob rows', () => {
  it("连守 bans repeating last night's target, and only that", () => {
    let s = apply(newWolfKingGame(), { type: 'START_GAME' });
    s = runNightWK(s, { guard: 5, kill: null });
    expect(s.lastProtected).toBe(5);
    s = toNextNight(s);
    expect(s.dayNumber).toBe(2);
    expectGameError(s, { type: 'GUARD_PROTECT', actor: 12, target: 5 }, 'INVALID_TARGET');
    const s2 = apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 6 });
    expect(s2.night?.protectTarget).toBe(6);
  });

  it('guardRepeatBan: false allows the repeat', () => {
    let s = apply(newWolfKingGame({ guardRepeatBan: false }), { type: 'START_GAME' });
    s = runNightWK(s, { guard: 5, kill: null });
    s = toNextNight(s);
    const s2 = apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 5 });
    expect(s2.night?.protectTarget).toBe(5);
  });

  it('自守 is rejected when guardSelfProtect is off', () => {
    const s = apply(newWolfKingGame({ guardSelfProtect: false }), { type: 'START_GAME' });
    expectGameError(s, { type: 'GUARD_PROTECT', actor: 12, target: 12 }, 'INVALID_TARGET');
    // Other targets still fine.
    const s2 = apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 5 });
    expect(s2.night?.protectTarget).toBe(5);
  });

  it('空守 is rejected when guardEmptyProtect is off', () => {
    const s = apply(newWolfKingGame({ guardEmptyProtect: false }), { type: 'START_GAME' });
    expectGameError(s, { type: 'GUARD_PASS', actor: 12 }, 'INVALID_TARGET');
    const s2 = apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 5 });
    expect(s2.night?.protectTarget).toBe(5);
  });

  it('the wolfking board bans witch self-save from night 1 onward', () => {
    let s = apply(newWolfKingGame(), { type: 'START_GAME' });
    s = apply(s, { type: 'GUARD_PASS', actor: 12 });
    s = nightKillWK(s, 10); // the witch is knifed but still alive at her step
    expectGameError(s, { type: 'WITCH_HEAL', actor: 10 }, 'POTION_SELF_SAVE');
  });

  it('a dead guard skips his turn — the wolves act immediately', () => {
    let s = apply(newWolfKingGame(), { type: 'START_GAME' });
    s = runNightWK(s, { guard: null, kill: 12 }); // the guard dies night 1
    s = toNextNight(s);
    expect(P(s, 12).alive).toBe(false);
    expect(s.night?.guardTurn).toBeNull();
    const s2 = nightKillWK(s, 5);
    expect(s2.night?.killTarget).toBe(5);
  });
});

describe('同守同救 (奶穿) — guard × witch × poison matrix', () => {
  it('protection + heal on the same target = the target dies anyway (default 奶穿)', () => {
    const s = runNightWK(apply(newWolfKingGame(), { type: 'START_GAME' }), {
      guard: 5,
      kill: 5,
      heal: true,
    });
    expect(s.pendingDawn?.map((r) => r.seat)).toEqual([5]);
    const resolved = s.log.find((e) => e.type === 'DEATH_RESOLVED');
    expect(resolved).toMatchObject({ type: 'DEATH_RESOLVED', seat: 5, cause: 'wolf-kill' });
  });

  it('guardHealSameTarget: "survive" lets both saves hold', () => {
    const s = runNightWK(
      apply(newWolfKingGame({ guardHealSameTarget: 'survive' }), { type: 'START_GAME' }),
      { guard: 5, kill: 5, heal: true },
    );
    expect(s.pendingDawn).toEqual([]);
    // Day 1 announces the dawn only after the election.
    const s2 = openDay(holdElection(s, [], null));
    expect(s2.log.some((e) => e.type === 'PEACEFUL_NIGHT')).toBe(true);
  });

  it('poison overrides protection', () => {
    const s = runNightWK(apply(newWolfKingGame(), { type: 'START_GAME' }), {
      guard: 5,
      kill: 5,
      poison: 5,
    });
    const resolved = s.log.find((e) => e.type === 'DEATH_RESOLVED');
    expect(resolved).toMatchObject({ type: 'DEATH_RESOLVED', seat: 5, cause: 'poison' });
  });

  it('poison overrides protection + heal together', () => {
    const s = runNightWK(apply(newWolfKingGame(), { type: 'START_GAME' }), {
      guard: 5,
      kill: 5,
      heal: true,
      poison: 5,
    });
    const resolved = s.log.find((e) => e.type === 'DEATH_RESOLVED');
    expect(resolved).toMatchObject({ type: 'DEATH_RESOLVED', seat: 5, cause: 'poison' });
  });
});

describe('guard legality and event visibility', () => {
  it('rejects GUARD_* from the wrong actor, the wrong moment, or the wrong phase', () => {
    let s = apply(newWolfKingGame(), { type: 'START_GAME' });
    // Not the guard.
    expectGameError(s, { type: 'GUARD_PROTECT', actor: 1, target: 5 }, 'NOT_YOUR_TURN');
    expectGameError(s, { type: 'GUARD_PASS', actor: 1 }, 'NOT_YOUR_TURN');
    // Already decided — no second action in the slot.
    s = apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 5 });
    expectGameError(s, { type: 'GUARD_PROTECT', actor: 12, target: 6 }, 'NOT_YOUR_TURN');
    expectGameError(s, { type: 'GUARD_PASS', actor: 12 }, 'NOT_YOUR_TURN');
    // Wrong phase entirely — the night closes once the seer acts.
    const over = seerTurn(witchTurn(nightKillWK(s, 5), {}));
    expectGameError(over, { type: 'GUARD_PROTECT', actor: 12, target: 5 }, 'WRONG_PHASE');
  });

  it('rejects impossible guard targets', () => {
    const s = apply(newWolfKingGame(), { type: 'START_GAME' });
    expectGameError(s, { type: 'GUARD_PROTECT', actor: 12, target: 0 }, 'INVALID_TARGET');
    expectGameError(s, { type: 'GUARD_PROTECT', actor: 12, target: 13 }, 'INVALID_TARGET');
  });

  it('keeps the guard events server-only', () => {
    expect(visibilityOf({ type: 'GUARD_PROTECTED', actor: 12, target: 5 })).toEqual({
      kind: 'server',
    });
    expect(visibilityOf({ type: 'GUARD_PASSED', actor: 12 })).toEqual({ kind: 'server' });
  });
});

describe('win check with the new roles', () => {
  it('counts the 白狼王 as a wolf and the guard as a god', () => {
    const s = newWolfKingGame();
    for (const seat of [1, 2, 3]) P(s, seat).alive = false;
    expect(winCheck(s)).toBeNull(); // the king keeps the wolf camp alive
    P(s, 4).alive = false;
    expect(winCheck(s)).toBe('good');

    const s2 = newWolfKingGame();
    for (const seat of [9, 10, 11, 12]) P(s2, seat).alive = false; // gods incl. guard
    expect(winCheck(s2)).toBe('wolves');
  });
});
