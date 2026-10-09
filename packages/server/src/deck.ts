import { randomInt } from 'node:crypto';
import { BOARDS, type BoardId, type Role, type Seat, type SeatAssignment } from '@werewolf/engine';

/**
 * Deals the named board (from the engine's board registry) to seats 1..12
 * with a crypto shuffle. Roles are dealt once at room creation and never
 * leave the server except through the per-seat view projection. The deck
 * composition lives in `BOARDS[boardId].deck` — adding a board needs no
 * change here.
 */
export function shuffledDeck(boardId: BoardId = 'classic'): SeatAssignment[] {
  const deck: Role[] = [];
  for (const [role, count] of Object.entries(BOARDS[boardId].deck) as Array<[Role, number]>) {
    for (let i = 0; i < count; i++) deck.push(role);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck.map((role, i) => ({ seat: (i + 1) as Seat, role }));
}
