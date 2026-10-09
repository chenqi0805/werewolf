import { randomInt } from 'node:crypto';
import type { Role, Seat, SeatAssignment } from '@werewolf/engine';

/** The standard 预女猎白 board: 4 wolves, 4 villagers, seer, witch, hunter, idiot. */
const STANDARD_DECK: readonly Role[] = [
  'werewolf',
  'werewolf',
  'werewolf',
  'werewolf',
  'villager',
  'villager',
  'villager',
  'villager',
  'seer',
  'witch',
  'hunter',
  'idiot',
];

/**
 * Deals the standard board to seats 1..12 with a crypto shuffle. Roles are
 * dealt once at room creation and never leave the server except through the
 * per-seat view projection.
 */
export function shuffledDeck(): SeatAssignment[] {
  const deck = [...STANDARD_DECK];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck.map((role, i) => ({ seat: (i + 1) as Seat, role }));
}
