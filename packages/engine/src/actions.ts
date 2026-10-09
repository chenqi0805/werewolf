import type { Seat } from './types';

/**
 * The player action protocol — the seam future AI-bot players plug into.
 * Humans submit these over Socket.IO; bots produce the same shapes through
 * the same validation path.
 *
 * Timing is server-side: when a phase timer expires the server injects the
 * default action for whoever owes a decision (abstain / no potion / pass).
 */
export type PlayerAction =
  // — night —
  /** Each living wolf votes; unique plurality wins, ties resolve to 空刀.
   *  `null` votes for no kill (空刀). */
  | { type: 'WOLF_KILL'; actor: Seat; target: Seat | null }
  /** Protects a player from tonight's wolf kill (守卫, wolfking boards). */
  | { type: 'GUARD_PROTECT'; actor: Seat; target: Seat }
  /** Declines to protect anyone (空守). */
  | { type: 'GUARD_PASS'; actor: Seat }
  /** Saves tonight's kill target. */
  | { type: 'WITCH_HEAL'; actor: Seat }
  /** One poison per game; self-poison is never legal. */
  | { type: 'WITCH_POISON'; actor: Seat; target: Seat }
  /** Ends the witch's night turn, declining any remaining potion. */
  | { type: 'WITCH_PASS'; actor: Seat }
  /** Camp check; the result is private to the seer forever. */
  | { type: 'SEER_CHECK'; actor: Seat; target: Seat }
  /** Declines tonight's check. */
  | { type: 'SEER_PASS'; actor: Seat }
  // — sheriff, day 1, before deaths are announced —
  | { type: 'SHERIFF_SIGNUP'; actor: Seat }
  /** 退水 — allowed while signup or candidate speeches are open. */
  | { type: 'SHERIFF_WITHDRAW'; actor: Seat }
  /** 警下 players only; `null` = abstain. */
  | { type: 'SHERIFF_VOTE'; actor: Seat; target: Seat | null }
  /** On death: hand the badge to a living player (`null` = 撕毁 destroy). */
  | { type: 'SHERIFF_PASS'; actor: Seat; target: Seat | null }
  // — day —
  /** Only inside your own speech slot. */
  | { type: 'SPEAK'; actor: Seat; text: string }
  /** `null` = abstain; no rights → rejected. */
  | { type: 'EXILE_VOTE'; actor: Seat; target: Seat | null }
  /** Only while the shot window is open; public event, no last words. */
  | { type: 'HUNTER_SHOOT'; actor: Seat; target: Seat }
  /** Declines the shot. */
  | { type: 'HUNTER_PASS'; actor: Seat }
  /** Sheriff sets the daily speech direction. */
  | { type: 'SET_SPEECH_DIRECTION'; actor: Seat; direction: 'cw' | 'ccw' };

/**
 * Server-injected control actions. Never accepted from a client socket.
 * `PROCEED` advances the current server-paced step: closing signup, ending a
 * speech slot, announcing the next night death, closing last words.
 */
export type ServerAction = { type: 'START_GAME' } | { type: 'PROCEED' };

export type GameAction = PlayerAction | ServerAction;
