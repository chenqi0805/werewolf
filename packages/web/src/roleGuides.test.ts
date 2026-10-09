import { describe, expect, it } from 'vitest';

import { ROLE_META } from './roles';
import { ROLE_GUIDES } from './roleGuides';

describe('ROLE_GUIDES', () => {
  it('covers every role exactly once', () => {
    const roles = ROLE_GUIDES.map((guide) => guide.role).sort();
    expect(roles).toEqual(Object.keys(ROLE_META).sort());
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('has no empty fields on any guide', () => {
    for (const guide of ROLE_GUIDES) {
      expect(guide.label.trim()).not.toBe('');
      expect(guide.winLine.trim()).not.toBe('');
      expect(guide.ability.trim()).not.toBe('');
      expect(guide.tips.length).toBeGreaterThan(0);
      for (const tip of guide.tips) expect(tip.trim()).not.toBe('');
    }
  });

  it('stays consistent with the ROLE_META seeds', () => {
    for (const guide of ROLE_GUIDES) {
      expect(guide.label).toBe(ROLE_META[guide.role].label);
      expect(guide.team).toBe(ROLE_META[guide.role].team);
    }
  });

  it('gives every good-camp guide the exile-the-wolves win line', () => {
    for (const guide of ROLE_GUIDES.filter((g) => g.team === 'good')) {
      expect(guide.winLine).toBe('放逐所有狼人。');
    }
  });
});
