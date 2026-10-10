import type { TallyBallot, TallyRow } from './events';
import { getPlayer } from './state';
import type { GameState } from './state';
import type { PlayerState, Seat } from './types';

/** Vote weight: the sheriff badge counts 1.5 in exile votes while held. */
export function voteWeight(p: PlayerState): number {
  return p.hasBadge ? 1.5 : 1;
}

/**
 * Full ballot reveal: every cast vote, voter-seat ascending, weights
 * attached. The caller emits it inside VOTE_TALLY — never before the close.
 */
export function tallyBallots(
  state: GameState,
  votes: Partial<Record<Seat, Seat | null>>,
): TallyBallot[] {
  return Object.keys(votes)
    .map(Number)
    .sort((a, b) => a - b)
    .map((voter) => {
      const target = votes[voter];
      return { voter, target: target ?? null, weight: voteWeight(getPlayer(state, voter)) };
    });
}

/**
 * Weighted counts per target seat. Abstentions are reported separately and
 * never win plurality. Votes are simultaneous and hidden until the tally.
 */
export function tallyVotes(
  state: GameState,
  votes: Partial<Record<Seat, Seat | null>>,
): { counts: Map<Seat, number>; abstains: number } {
  const counts = new Map<Seat, number>();
  let abstains = 0;
  for (const key of Object.keys(votes)) {
    const actor = Number(key);
    const target = votes[actor];
    const voter = getPlayer(state, actor);
    if (target === null || target === undefined) {
      abstains += voteWeight(voter);
      continue;
    }
    counts.set(target, (counts.get(target) ?? 0) + voteWeight(voter));
  }
  return { counts, abstains };
}

export interface Plurality<K> {
  /** Unique strict maximum; null when tied or empty. */
  winner: K | null;
  /** All keys sharing the max — length > 1 exactly when tied. */
  tied: K[];
}

/** Unique-strict-maximum scan. Ties produce no winner (PK or 空刀 instead). */
export function plurality<K>(counts: Map<K, number>): Plurality<K> {
  let max = -Infinity;
  for (const v of counts.values()) {
    if (v > max) max = v;
  }
  if (max < 0) return { winner: null, tied: [] };
  const tied = [...counts.entries()]
    .filter(([, v]) => v === max)
    .map(([k]) => k)
    .sort(seatOrder);
  return { winner: tied.length === 1 ? (tied[0] ?? null) : null, tied };
}

/** Sort that also tolerates the null option (null first). */
function seatOrder<K>(a: K, b: K): number {
  const av = a === null ? -1 : (a as number);
  const bv = b === null ? -1 : (b as number);
  return av - bv;
}

/** Public tally rows: targets by descending votes, abstentions last. */
export function tallyRows(counts: Map<Seat, number>, abstains: number): TallyRow[] {
  const rows: TallyRow[] = [...counts.entries()]
    .map(([seat, votes]) => ({ seat, votes }))
    .sort((a, b) => b.votes - a.votes || a.seat - b.seat);
  if (abstains > 0) rows.push({ seat: null, votes: abstains });
  return rows;
}
