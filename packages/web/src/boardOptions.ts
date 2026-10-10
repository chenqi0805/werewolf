import { BOARDS, type BoardId, type Role } from '@werewolf/engine';

import { ROLE_META } from './roles';

/**
 * The board picker's data, derived from the engine registry — adding a board
 * there is all it takes for the picker to offer it. Pure and unit-tested; the
 * screen only renders these rows.
 */

/** Deck display order: wolf camp first, then villagers, then the gods. */
const DISPLAY_ORDER: readonly Role[] = [
  'werewolf',
  'white_wolf_king',
  'villager',
  'seer',
  'witch',
  'hunter',
  'guard',
  'idiot',
];

function lineupOf(boardId: BoardId): string {
  const deck = BOARDS[boardId].deck;
  return DISPLAY_ORDER.filter((role) => (deck[role] ?? 0) > 0)
    .map((role) => {
      const count = deck[role] ?? 0;
      return count > 1 ? `${ROLE_META[role].label}×${count}` : ROLE_META[role].label;
    })
    .join(' · ');
}

export interface BoardOption {
  id: BoardId;
  name: string;
  /** One-line lineup preview, e.g. 「狼人×4 · 村民×4 · 预言家 · …」. */
  lineup: string;
}

/** Picker rows in registry order (classic first). */
export const BOARD_OPTIONS: readonly BoardOption[] = (Object.keys(BOARDS) as BoardId[]).map(
  (id) => ({ id, name: BOARDS[id].name, lineup: lineupOf(id) }),
);

/** One row by board id — the log's game-start line reads it. */
export function boardOptionOf(id: BoardId): BoardOption {
  return { id, name: BOARDS[id].name, lineup: lineupOf(id) };
}
