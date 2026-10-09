/**
 * Contested rule knobs, pinned to the researched standard for the 12-player
 * 预女猎白 board. Each is a single config constant: flipping one is a config
 * change plus a test update, never an architecture change.
 */
export interface EngineConfig {
  /** Nights on which the witch may heal herself. Standard: night 1 only. */
  witchSelfSaveNights: readonly number[];
  /** Both potions usable in the same night. */
  witchDoublePotion: boolean;
  /** A poisoned hunter may not shoot (poison + wolf kill counts as poisoned). */
  poisonSilencesHunter: boolean;
  /** Once revealed, the idiot cannot be removed by an exile vote. */
  idiotUnexilableAfterReveal: boolean;
  /** Which night deaths give last words. Standard: night-1 deaths only. */
  nightDeathLastWords: 'night1-only' | 'none';
  /** Wolves may decline to kill (空刀 → 平安夜). */
  emptyKnife: boolean;
  /** Speech round starts with the sheriff instead of his first successor. */
  sheriffSpeaksFirst: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  witchSelfSaveNights: [1],
  witchDoublePotion: true,
  poisonSilencesHunter: true,
  idiotUnexilableAfterReveal: true,
  nightDeathLastWords: 'night1-only',
  emptyKnife: true,
  sheriffSpeaksFirst: false,
};
