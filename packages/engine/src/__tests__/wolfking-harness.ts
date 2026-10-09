import type { EngineConfig, GameState, Seat, SeatAssignment } from '../index';
import { campOf } from '../types';
import { createGame } from '../create';

/**
 * The 预女猎守 deal used by the wolfking suites. Role seats mirror the classic
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

export function newWolfKingGame(config?: EngineConfig): GameState {
  return createGame(WOLF_KING_STANDARD, 'wolfking', config);
}

/** Living wolf-camp seats (wolves + 白狼王) in seat order. */
export function livingWolvesWK(state: GameState): Seat[] {
  return Object.values(state.players)
    .filter((p) => p.alive && campOf(p.role) === 'wolf')
    .map((p) => p.seat);
}
