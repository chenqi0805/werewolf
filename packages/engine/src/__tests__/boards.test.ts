import { describe, expect, it } from 'vitest';
import type { SeatAssignment } from '../index';
import { BOARDS, DEFAULT_CONFIG, campOf, createGame } from '../index';
import { STANDARD, P, expectCreateError } from './harness';
import { WOLF_KING_STANDARD, newWolfKingGame } from './wolfking-harness';

describe('board registry', () => {
  it('keeps the classic deck and night order as the v1 constants', () => {
    expect(BOARDS.classic.deck).toEqual({
      werewolf: 4,
      villager: 4,
      seer: 1,
      witch: 1,
      hunter: 1,
      idiot: 1,
    });
    expect(BOARDS.classic.nightOrder).toEqual(['wolf', 'witch', 'seer']);
  });

  it('declares the wolfking deck and guard-first night order', () => {
    expect(BOARDS.wolfking.deck).toEqual({
      werewolf: 3,
      villager: 4,
      white_wolf_king: 1,
      seer: 1,
      witch: 1,
      hunter: 1,
      guard: 1,
    });
    expect(BOARDS.wolfking.nightOrder).toEqual(['guard', 'wolf', 'witch', 'seer']);
  });

  it('defaults the classic board to the shipped v1 config', () => {
    expect(BOARDS.classic.config).toEqual(DEFAULT_CONFIG);
  });

  it('applies the competitive standard to the wolfking board', () => {
    const c = BOARDS.wolfking.config;
    expect(c.witchSelfSaveNights).toEqual([]); // 全程不可自救
    expect(c.wolfKnifeFirst).toBe(true); // 狼刀在先
    expect(c.guardRepeatBan).toBe(true); // 连守
    expect(c.guardSelfProtect).toBe(true); // 自守
    expect(c.guardEmptyProtect).toBe(true); // 空守
    expect(c.guardHealSameTarget).toBe('death'); // 同守同救 → 奶穿
    expect(c.wolfKingDestructWindows).toEqual(['speech', 'exile-settlement']);
    expect(c.destructLastWords).toBe(false);
    expect(c.destructBadgeSwallow).toBe(2); // 双爆吞警徽
  });
});

describe('createGame with the registry', () => {
  it('keeps the v1 single-argument shape on the classic board', () => {
    const s = createGame(STANDARD);
    expect(s.board).toBe('classic');
    expect(s.config).toEqual(DEFAULT_CONFIG);
    expect(P(s, 12).role).toBe('idiot');
  });

  it('keeps the v1 two-argument config shape on the classic board', () => {
    const s = createGame(STANDARD, { ...DEFAULT_CONFIG, emptyKnife: false });
    expect(s.board).toBe('classic');
    expect(s.config.emptyKnife).toBe(false);
    expect(s.config.witchSelfSaveNights).toEqual([1]);
  });

  it('seats the wolfking lineup with the board defaults', () => {
    const s = newWolfKingGame();
    expect(s.board).toBe('wolfking');
    expect(s.config.witchSelfSaveNights).toEqual([]);
    expect(s.config.wolfKnifeFirst).toBe(true);
    expect(P(s, 4).role).toBe('white_wolf_king');
    expect(P(s, 4).private).toEqual({ kind: 'white_wolf_king', destructUsed: false });
    expect(P(s, 12).role).toBe('guard');
    expect(P(s, 12).private).toEqual({ kind: 'guard' });
  });

  it('merges per-knob overrides over the board defaults', () => {
    const s = createGame(WOLF_KING_STANDARD, 'wolfking', {
      wolfKnifeFirst: false,
      guardRepeatBan: false,
    });
    expect(s.config.wolfKnifeFirst).toBe(false);
    expect(s.config.guardRepeatBan).toBe(false);
    // Board defaults the override does not mention survive untouched.
    expect(s.config.witchSelfSaveNights).toEqual([]);
    expect(s.config.guardHealSameTarget).toBe('death');
  });

  it('rejects the classic lineup on the wolfking board', () => {
    expectCreateErrorWolf(STANDARD);
  });

  it('rejects the wolfking lineup on the classic board', () => {
    expectCreateError(WOLF_KING_STANDARD, 'INVALID_LINEUP');
  });

  it('rejects a foreign role even when role counts balance', () => {
    // Same counts as wolfking but with the guard swapped for an idiot.
    const swapped: SeatAssignment[] = WOLF_KING_STANDARD.map((a) =>
      a.seat === 12 ? { seat: 12, role: 'idiot' } : a,
    );
    expectCreateErrorWolf(swapped);
  });

  it('still rejects short lineups and duplicate seats', () => {
    expectCreateError(WOLF_KING_STANDARD.slice(0, 11), 'INVALID_LINEUP');
    // 12 entries, but seat 12 dealt twice (seat 11 skipped).
    const doubled = WOLF_KING_STANDARD.map((a) =>
      a.seat === 11 ? { seat: 12, role: 'hunter' as const } : a,
    );
    expectCreateError(doubled, 'SEAT_TAKEN');
  });
});

describe('campOf', () => {
  it('camps the 白狼王 with the wolves and the guard with the good', () => {
    expect(campOf('white_wolf_king')).toBe('wolf');
    expect(campOf('werewolf')).toBe('wolf');
    expect(campOf('guard')).toBe('good');
    expect(campOf('seer')).toBe('good');
    expect(campOf('villager')).toBe('good');
    expect(campOf('idiot')).toBe('good');
  });
});

/** createGame against the wolfking board — the v1 helper pins the classic. */
function expectCreateErrorWolf(assignments: SeatAssignment[]): void {
  try {
    createGame(assignments, 'wolfking');
  } catch (e) {
    expect((e as { code: string }).code).toBe('INVALID_LINEUP');
    return;
  }
  throw new Error('expected GameError INVALID_LINEUP, but createGame succeeded');
}
