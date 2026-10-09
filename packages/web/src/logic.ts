import type { LogEntry, Seat } from './types';

/**
 * Reason the witch cannot heal tonight, or null when the heal is available.
 * Precedence matters: a spent potion is the permanent state, 空刀 means there
 * is no target at all, and the self-save rule only binds when she is the target.
 */
export function healBlockReason(
  killTarget: Seat | null,
  self: Seat,
  healUsed: boolean,
  maySelfSave: boolean,
): string | null {
  if (healUsed) return '解药已用完';
  if (killTarget === null) return '今晚空刀，无人可救';
  if (killTarget === self && !maySelfSave) return '首夜之外不能自救';
  return null;
}

/** Reason the witch cannot poison tonight, or null when the poison is available. */
export function poisonBlockReason(poisonUsed: boolean): string | null {
  return poisonUsed ? '毒药已用完' : null;
}

/** "1.5" for the sheriff's weighted vote, integers without a decimal. */
export function formatVotes(votes: number): string {
  return Number.isInteger(votes) ? String(votes) : votes.toFixed(1);
}

/** Entries grouped by day number, ascending; preserves within-day order. */
export function groupEntriesByDay(
  entries: LogEntry[],
): Array<{ day: number; entries: LogEntry[] }> {
  const byDay = new Map<number, LogEntry[]>();
  for (const entry of entries) {
    const bucket = byDay.get(entry.day);
    if (bucket) bucket.push(entry);
    else byDay.set(entry.day, [entry]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, dayEntries]) => ({ day, entries: dayEntries }));
}

/** "2号、5号、9号" — Chinese seat list used in tallies and log lines. */
export function seatsLabel(seats: Seat[]): string {
  if (seats.length === 0) return '无人';
  return seats.map((seat) => `${seat}号`).join('、');
}
