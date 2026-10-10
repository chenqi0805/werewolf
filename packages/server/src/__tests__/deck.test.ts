import { describe, expect, it } from 'vitest';
import { SEAT_COUNT } from '@werewolf/engine';
import { shuffledDeck } from '../deck';

describe('shuffledDeck', () => {
  it('deals the standard board across every seat', () => {
    const deck = shuffledDeck();
    expect(deck).toHaveLength(SEAT_COUNT);
    const counts = new Map<string, number>();
    for (const { seat, role } of deck) {
      expect(seat).toBeGreaterThanOrEqual(1);
      expect(seat).toBeLessThanOrEqual(SEAT_COUNT);
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    expect(counts.get('werewolf')).toBe(4);
    expect(counts.get('villager')).toBe(4);
    expect(counts.get('seer')).toBe(1);
    expect(counts.get('witch')).toBe(1);
    expect(counts.get('hunter')).toBe(1);
    expect(counts.get('idiot')).toBe(1);
  });

  it('does not deal the same order twice', () => {
    const deals = new Set<string>();
    for (let i = 0; i < 20; i++) {
      deals.add(
        shuffledDeck()
          .map((a) => a.role)
          .join(','),
      );
    }
    expect(deals.size).toBeGreaterThan(1);
  });
});

describe('deal distribution', () => {
  it('keeps every seat-role frequency within 4.5σ over 12000 deals', () => {
    const DEALS = 12_000;
    // Classic board composition: werewolf and villager each cover 4 of the 12
    // seats; the four singletons cover 1.
    const ROLE_PROBABILITY = {
      werewolf: 1 / 3,
      villager: 1 / 3,
      seer: 1 / 12,
      witch: 1 / 12,
      hunter: 1 / 12,
      idiot: 1 / 12,
    };

    const counts = new Map<string, number>();
    for (let i = 0; i < DEALS; i++) {
      for (const { seat, role } of shuffledDeck()) {
        const key = `${seat}:${role}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    // Per-seat binomial: a biased shuffle (e.g. sort(() => Math.random() - 0.5))
    // skews some seat-role cell far past 4.5σ; a fair one stays well inside.
    let worstSigma = 0;
    let worstCell = '';
    for (let seat = 1; seat <= SEAT_COUNT; seat++) {
      for (const [role, p] of Object.entries(ROLE_PROBABILITY)) {
        const sd = Math.sqrt(DEALS * p * (1 - p));
        const sigma = Math.abs((counts.get(`${seat}:${role}`) ?? 0) - DEALS * p) / sd;
        if (sigma > worstSigma) {
          worstSigma = sigma;
          worstCell = `${role} in seat ${seat}`;
        }
      }
    }

    // A fair shuffle false-flags 4.5σ in under 0.1% of runs; the validated
    // implementation measured worst 2.31σ (seat 3 hunter, 1070 vs 1000).
    expect(worstSigma, `worst cell: ${worstCell}`).toBeLessThan(4.5);
  });
});
