import type { Seat, SeatAssignment } from '@werewolf/engine';
import { SEAT_COUNT } from '@werewolf/engine';
import { Room } from '../room';

/**
 * Fixed standard lineup for deterministic tests.
 * Wolves 1-4, villagers 5-8, seer 9, witch 10, hunter 11, idiot 12.
 */
export const STANDARD: SeatAssignment[] = [
  { seat: 1, role: 'werewolf' },
  { seat: 2, role: 'werewolf' },
  { seat: 3, role: 'werewolf' },
  { seat: 4, role: 'werewolf' },
  { seat: 5, role: 'villager' },
  { seat: 6, role: 'villager' },
  { seat: 7, role: 'villager' },
  { seat: 8, role: 'villager' },
  { seat: 9, role: 'seer' },
  { seat: 10, role: 'witch' },
  { seat: 11, role: 'hunter' },
  { seat: 12, role: 'idiot' },
];

export const ALL_SEATS: readonly Seat[] = Array.from({ length: SEAT_COUNT }, (_, i) => i + 1);

/**
 * Fixed 预女猎守 lineup for deterministic tests. Mirrors the engine's wolfking
 * harness where possible: wolves 1-3, 白狼王 4, villagers 5-8, seer 9,
 * witch 10, hunter 11 — and the guard takes the last seat, 12.
 */
export const WOLF_KING_STANDARD: SeatAssignment[] = [
  { seat: 1, role: 'werewolf' },
  { seat: 2, role: 'werewolf' },
  { seat: 3, role: 'werewolf' },
  { seat: 4, role: 'white_wolf_king' },
  { seat: 5, role: 'villager' },
  { seat: 6, role: 'villager' },
  { seat: 7, role: 'villager' },
  { seat: 8, role: 'villager' },
  { seat: 9, role: 'seer' },
  { seat: 10, role: 'witch' },
  { seat: 11, role: 'hunter' },
  { seat: 12, role: 'guard' },
];

/** A lobby room with the fixed deck (Room-level test seam, no sockets). */
export function fixedRoom(): Room {
  return new Room({ code: 'TEST', assignments: [...STANDARD] });
}

/** A lobby room with the fixed 预女猎守 deck (engine wolfking lineup). */
export function fixedWolfKingRoom(): Room {
  return new Room({ code: 'TESTWK', assignments: [...WOLF_KING_STANDARD], boardId: 'wolfking' });
}
