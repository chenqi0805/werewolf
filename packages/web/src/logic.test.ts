import { describe, expect, it } from 'vitest';

import {
  formatVotes,
  groupEntriesByDay,
  healBlockReason,
  poisonBlockReason,
  seatsLabel,
} from './logic';
import type { LogEntry } from './types';

const entry = (day: number, id: string): LogEntry => ({ id, day, kind: 'system', text: id });

describe('healBlockReason', () => {
  it('allows the night-1 self save', () => {
    expect(healBlockReason(5, 5, false, true)).toBeNull();
  });

  it('blocks a self save after night 1', () => {
    expect(healBlockReason(5, 5, false, false)).toBe('首夜之外不能自救');
  });

  it('blocks when the pack passed the knife (空刀)', () => {
    expect(healBlockReason(null, 3, false, true)).toBe('今晚空刀，无人可救');
  });

  it('blocks when the heal potion is spent', () => {
    expect(healBlockReason(7, 3, true, true)).toBe('解药已用完');
  });

  it('allows healing someone else on any night', () => {
    expect(healBlockReason(7, 3, false, false)).toBeNull();
  });
});

describe('poisonBlockReason', () => {
  it('blocks once the poison is spent', () => {
    expect(poisonBlockReason(true)).toBe('毒药已用完');
  });

  it('is available while unused', () => {
    expect(poisonBlockReason(false)).toBeNull();
  });
});

describe('formatVotes', () => {
  it('renders whole votes plainly', () => {
    expect(formatVotes(3)).toBe('3');
  });

  it('keeps the sheriff half vote', () => {
    expect(formatVotes(1.5)).toBe('1.5');
  });
});

describe('groupEntriesByDay', () => {
  it('groups in ascending day order and preserves within-day order', () => {
    const grouped = groupEntriesByDay([entry(2, 'b'), entry(1, 'a'), entry(2, 'c')]);
    expect(grouped.map((group) => [group.day, group.entries.map((e) => e.id)])).toEqual([
      [1, ['a']],
      [2, ['b', 'c']],
    ]);
  });

  it('returns no groups for an empty log', () => {
    expect(groupEntriesByDay([])).toEqual([]);
  });
});

describe('seatsLabel', () => {
  it('joins seats in Chinese list form', () => {
    expect(seatsLabel([2, 5, 9])).toBe('2号、5号、9号');
  });

  it('falls back to 无人 for an empty list', () => {
    expect(seatsLabel([])).toBe('无人');
  });
});
