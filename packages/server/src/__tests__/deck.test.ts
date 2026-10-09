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
