/**
 * View-model types the presentational layer renders.
 *
 * The composition layer (a later wiring PR) adapts the server's per-seat
 * `PlayerView` projections onto these shapes. Components stay pure:
 * props in, events out — no fetches, no sockets, no global stores.
 */

/** Seat number, 1..12. Seat order drives speech and vote order. */
export type Seat = number;

// Kept in sync with the engine's board registry (v2 adds 白狼王 + guard).
export type Role =
  'werewolf' | 'white_wolf_king' | 'villager' | 'seer' | 'witch' | 'hunter' | 'guard' | 'idiot';

export type Camp = 'wolves' | 'good';

/** One seat as the UI renders it — public info plus what this viewer may see. */
export interface SeatView {
  seat: Seat;
  /** Display name chosen at join (v1 has no accounts). */
  name: string;
  alive: boolean;
  isSelf: boolean;
  /** Holds the sheriff badge (警徽). */
  isSheriff: boolean;
  /** Currently in their speech slot. */
  isSpeaking?: boolean;
  /** Set only once the role is publicly revealed (idiot flip, game over). */
  role?: Role;
  /** Flipped idiot: alive and still speaking, but never votes again. */
  revealedIdiot?: boolean;
  /** A session holds this seat. Undefined reads as occupied (mid-game rows are always seated). */
  occupied?: boolean;
}

/** One entry in the seer's private check history. */
export interface SeerResult {
  seat: Seat;
  isWolf: boolean;
}

export interface SpeechMessage {
  id: string;
  seat: Seat;
  name: string;
  text: string;
}

/** The four speech contexts that share one transcript. */
export type SpeechContext = 'speech' | 'sheriff-speech' | 'last-words' | 'pk-speech';

/** One accepted speech in the permanent record, pinned to its game day. */
export interface SpeechRecord {
  day: number;
  context: SpeechContext;
  seat: Seat;
  name: string;
  text: string;
}

export type LogKind = 'death' | 'vote' | 'system' | 'sheriff' | 'reveal';

export interface LogEntry {
  id: string;
  day: number;
  kind: LogKind;
  text: string;
}

/** One resolved exile-vote row: who got how many votes from whom. */
export interface VoteTallyRow {
  /** `null` when the row aggregates abstentions. */
  target: Seat | null;
  voterSeats: Seat[];
  /** Fractional votes are possible: the sheriff counts 1.5. */
  votes: number;
}

export interface VoteTally {
  rows: VoteTallyRow[];
  abstainers: Seat[];
  /** `null` when the vote was voided or nobody received a vote. */
  exiled: Seat | null;
  /** Tied vote: nobody is exiled today. */
  voided: boolean;
}

/** Which side won the game. */
export type WinSide = 'wolves' | 'good';

/** Fully revealed player row for the game-over screen. */
export interface PlayerReveal {
  seat: Seat;
  role: Role;
  alive: boolean;
  /** Died while holding the sheriff badge. */
  hasBadge: boolean;
}
