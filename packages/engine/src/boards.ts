/**
 * The board registry — the single source for every supported lineup: deck
 * composition, night order, and per-board rule defaults. Client role metadata
 * and e2e labels consume this data rather than maintaining parallel role
 * lists, so adding a board is adding an entry here.
 */
import type { EngineConfig } from './config';
import { DEFAULT_CONFIG } from './config';
import type { Role } from './types';

/** The boards shipped in v2. `classic` is the v1 预女猎白 lineup. */
export type BoardId = 'classic' | 'wolfking';

/**
 * A night step — whose decision the night is waiting on. The wire/state
 * `NightState.step` field keeps the v1 literals (`wolf`/`witch`/`seer`);
 * boards whose night order puts the guard first open his turn through
 * `NightState.guardTurn` before the wolf step.
 */
export type NightStep = 'guard' | 'wolf' | 'witch' | 'seer';

export interface BoardDefinition {
  id: BoardId;
  /** Display name, e.g. 「标准局 · 预女猎白」. */
  name: string;
  /** Exact role counts; roles omitted are not on the board. */
  deck: Partial<Record<Role, number>>;
  /** The order roles wake in during the night. */
  nightOrder: readonly NightStep[];
  /** Per-board defaults for every contested knob. */
  config: EngineConfig;
}

/** The v1 board: 4 wolves, 4 villagers, 预女猎白 + idiot. Behavior is frozen. */
const CLASSIC: BoardDefinition = {
  id: 'classic',
  name: '标准局 · 预女猎白',
  deck: { werewolf: 4, villager: 4, seer: 1, witch: 1, hunter: 1, idiot: 1 },
  nightOrder: ['wolf', 'witch', 'seer'],
  config: { ...DEFAULT_CONFIG },
};

/**
 * The competitive 预女猎守 board: 4 villagers, 3 wolves + 白狼王, seer, witch,
 * hunter, guard. Per the competitive standard: the guard wakes first, the
 * witch can never self-save, and a settlement that completes both camps'
 * win conditions at once favors the wolves (狼刀在先).
 */
const WOLF_KING: BoardDefinition = {
  id: 'wolfking',
  name: '白狼王局 · 预女猎守',
  deck: {
    werewolf: 3,
    villager: 4,
    white_wolf_king: 1,
    seer: 1,
    witch: 1,
    hunter: 1,
    guard: 1,
  },
  nightOrder: ['guard', 'wolf', 'witch', 'seer'],
  config: { ...DEFAULT_CONFIG, witchSelfSaveNights: [], wolfKnifeFirst: true },
};

export const BOARDS: Record<BoardId, BoardDefinition> = { classic: CLASSIC, wolfking: WOLF_KING };
