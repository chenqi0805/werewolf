/**
 * The 白狼王's destruct windows. `speech` = during a day speech round;
 * `exile-settlement` = when he himself is exiled, before the day settles.
 */
export type WolfKingDestructWindow = 'speech' | 'exile-settlement';

/**
 * Contested rule knobs, pinned to the researched standard for the 12-player
 * 预女猎白 board. Each is a single config constant: flipping one is a config
 * change plus a test update, never an architecture change. Boards override
 * the defaults through `BOARDS[board].config` — see boards.ts.
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
  /** 连守 — the guard may not protect the same player two nights running. */
  guardRepeatBan: boolean;
  /** 自守 — the guard may protect himself. */
  guardSelfProtect: boolean;
  /** 空守 — the guard may decline to protect anyone. */
  guardEmptyProtect: boolean;
  /**
   * 同守同救 — guard protection and the witch's heal on the same target:
   * 'death' is the competitive 奶穿 (the saves cancel and the knife lands);
   * 'survive' lets both saves stack.
   */
  guardHealSameTarget: 'death' | 'survive';
  /** Where the 白狼王 may self-destruct (带人). */
  wolfKingDestructWindows: readonly WolfKingDestructWindow[];
  /** Last words after a self-destruct; the competitive standard is none. */
  destructLastWords: boolean;
  /** 双爆吞警徽 — the Nth wolf self-destruct destroys the badge; 0 disables. */
  destructBadgeSwallow: number;
  /**
   * 狼刀在先 — when one settlement completes both camps' win conditions,
   * the wolves win. The classic board keeps the v1 ruling: good wins ties.
   */
  wolfKnifeFirst: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  witchSelfSaveNights: [1],
  witchDoublePotion: true,
  poisonSilencesHunter: true,
  idiotUnexilableAfterReveal: true,
  nightDeathLastWords: 'night1-only',
  emptyKnife: true,
  sheriffSpeaksFirst: false,
  guardRepeatBan: true,
  guardSelfProtect: true,
  guardEmptyProtect: true,
  guardHealSameTarget: 'death',
  wolfKingDestructWindows: ['speech', 'exile-settlement'],
  destructLastWords: false,
  destructBadgeSwallow: 2,
  wolfKnifeFirst: false,
};
