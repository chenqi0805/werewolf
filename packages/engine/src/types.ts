/**
 * Core domain types for the Werewolf rules engine.
 *
 * This package is pure: no sockets, timers, persistence, or rendering.
 * The server owns transport and pacing; the client renders projections.
 */

/** Seat number, 1-based. Seat order drives speech and vote order. */
export type Seat = number;

/** The standard 12-player 预女猎白 board. */
export const SEAT_COUNT = 12;

export type Role = 'werewolf' | 'villager' | 'seer' | 'witch' | 'hunter' | 'idiot';

/** One seat's dealt role, produced by the room server's shuffled deck. */
export interface SeatAssignment {
  seat: Seat;
  role: Role;
}

/** The two camps. Villagers and gods are both 'good'. */
export type Camp = 'wolf' | 'good';

/** The four god roles for the 屠边 win condition. */
export const GOD_ROLES: readonly Role[] = ['seer', 'witch', 'hunter', 'idiot'];

export function campOf(role: Role): Camp {
  return role === 'werewolf' ? 'wolf' : 'good';
}

/**
 * Game phases.
 *
 * - `lobby` exists only before the first action; the server starts the game.
 * - `dawn-announce`, `last-words`, and the speech phases are paced by the
 *   server clock via the `PROCEED` control action.
 * - `hunter-shot` and `badge-pass` are interrupts that open while the
 *   engine drains its death-resolution queue.
 */
export type Phase =
  | 'lobby'
  | 'night'
  | 'sheriff-signup'
  | 'sheriff-speech'
  | 'sheriff-vote'
  | 'dawn-announce'
  | 'last-words'
  | 'speech'
  | 'exile-vote'
  | 'pk-speech'
  | 'pk-vote'
  | 'hunter-shot'
  | 'badge-pass'
  | 'game-over';

/**
 * Per-player secrets the server reads to build private views. Never broadcast
 * raw; the view projection decides what each seat may see.
 */
export type PrivateState =
  | { kind: 'werewolf' }
  | { kind: 'villager' }
  | { kind: 'seer'; checks: Partial<Record<Seat, Camp>> }
  | { kind: 'witch'; healUsed: boolean; poisonUsed: boolean }
  | { kind: 'hunter'; shotUsed: boolean }
  | { kind: 'idiot' };

export interface PlayerState {
  seat: Seat;
  role: Role;
  alive: boolean;
  /** Flipped 白痴: still speaks, never votes again, cannot be exiled again. */
  revealedIdiot: boolean;
  /** Holds the sheriff badge — 1.5 vote weight in exile votes while held. */
  hasBadge: boolean;
  private: PrivateState;
}

/** Vote rights: alive and not a revealed idiot. */
export function canVote(p: PlayerState): boolean {
  return p.alive && !p.revealedIdiot;
}
