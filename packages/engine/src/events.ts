import type { DeathCause } from './state';
import type { Camp, Seat } from './types';

/** Who may see an event in their projected view. `server` = audit only. */
export type EventVisibility =
  { kind: 'public' } | { kind: 'private'; seats: Seat[] } | { kind: 'server' };

export interface TallyRow {
  /** `null` = abstentions. */
  seat: Seat | null;
  votes: number;
}

/**
 * Append-only audit trail. The log is the replay source: applying the same
 * action sequence from `createGame` reproduces the same states and events.
 * Night death *causes* are only ever visible in `server` events — public
 * announcements never name a cause.
 */
export type GameEvent =
  | { type: 'GAME_STARTED' }
  | { type: 'NIGHT_BEGAN'; dayNumber: number }
  | { type: 'DAY_BROKE'; dayNumber: number }
  | { type: 'PEACEFUL_NIGHT' }
  /** Night death: cause hidden. */
  | { type: 'DEATH_ANNOUNCED'; seat: Seat }
  /** Server-only audit twin of DEATH_ANNOUNCED, carrying the cause. */
  | { type: 'DEATH_RESOLVED'; seat: Seat; cause: DeathCause }
  | { type: 'WOLF_KILL_VOTE'; actor: Seat; target: Seat | null }
  /** `null` = 空刀. Server-only; the witch's view reads state during her step. */
  | { type: 'KILL_TARGET_SET'; target: Seat | null }
  | { type: 'WITCH_HEALED'; actor: Seat; target: Seat }
  | { type: 'WITCH_POISONED'; actor: Seat; target: Seat }
  | { type: 'WITCH_PASSED'; actor: Seat }
  /** Private to the seer, permanently. */
  | { type: 'SEER_CHECKED'; actor: Seat; target: Seat; result: Camp }
  | { type: 'SEER_PASSED'; actor: Seat }
  | { type: 'SHERIFF_SIGNUP_MADE'; seat: Seat }
  | { type: 'SHERIFF_WITHDREW'; seat: Seat }
  | { type: 'SHERIFF_VOTE_CAST'; actor: Seat; target: Seat | null }
  | { type: 'SHERIFF_ELECTED'; seat: Seat }
  | { type: 'NO_SHERIFF' }
  | { type: 'EXILE_VOTE_CAST'; actor: Seat; target: Seat | null }
  /** Hidden until the tally; totals are weighted (sheriff 1.5). */
  | { type: 'VOTE_TALLY'; kind: 'sheriff' | 'exile'; counts: TallyRow[] }
  | {
      type: 'SPEECH_MADE';
      seat: Seat;
      text: string;
      context: 'sheriff-speech' | 'last-words' | 'speech' | 'pk-speech';
    }
  | { type: 'SPEECH_ORDER_SET'; direction: 'cw' | 'ccw'; order: Seat[] }
  | { type: 'PLAYER_EXILED'; seat: Seat }
  | { type: 'IDIOT_REVEALED'; seat: Seat }
  /** A vote landed on the revealed idiot — nobody is removed. */
  | { type: 'EXILE_BLOCKED_BY_IDIOT'; seat: Seat }
  /** Public: shooting reveals the hunter. */
  | { type: 'HUNTER_SHOT'; shooter: Seat; target: Seat }
  | { type: 'HUNTER_PASSED'; shooter: Seat }
  | { type: 'BADGE_PASSED'; from: Seat; to: Seat }
  | { type: 'BADGE_DESTROYED'; from: Seat }
  | { type: 'GAME_OVER'; winner: 'wolves' | 'good' };

/** Visibility policy per event type; the server's view projection consumes it. */
export function visibilityOf(event: GameEvent): EventVisibility {
  switch (event.type) {
    case 'SEER_CHECKED':
      return { kind: 'private', seats: [event.actor] };
    case 'DEATH_RESOLVED':
    case 'WOLF_KILL_VOTE':
    case 'KILL_TARGET_SET':
    case 'WITCH_HEALED':
    case 'WITCH_POISONED':
    case 'WITCH_PASSED':
    case 'SEER_PASSED':
    case 'SHERIFF_VOTE_CAST':
    case 'EXILE_VOTE_CAST':
      return { kind: 'server' };
    default:
      return { kind: 'public' };
  }
}
