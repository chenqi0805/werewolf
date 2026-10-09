import type { GameEvent, PlayerAction } from '@werewolf/engine';
import type { PlayerView } from '@werewolf/server';

/**
 * The strategy seam — everything a bot brain ever sees or returns.
 *
 * A strategy decides from the fog-of-war `PlayerView` alone (plus the speech
 * it can read off the public log); it may never touch engine or server state.
 * Two implementations ship: `ScriptedStrategy` — deterministic heuristics
 * that power CI, e2e, and the live fallback — and the local-LLM brain that
 * later rides the same seam without protocol drift.
 */
export interface BotContext {
  /** The bot's ENTIRE sensory input — step, you, timer, visible log. */
  view: PlayerView;
  /** Last N speech texts visible to this seat, oldest first. */
  recentSpeech: string[];
  /** Seeded stream; scripted play stays deterministic in CI. */
  rng: () => number;
}

/**
 * One decision. `action` is the move to emit now; `speech`, when present on a
 * non-SPEAK action, is the text the runner submits as the bot's SPEAK if it
 * currently holds the speech slot — the only social channel a bot has.
 */
export interface BotDecision {
  action: PlayerAction;
  speech?: string;
}

export interface BotStrategy {
  /** The view's current step, or null when nothing is owed right now. */
  decide(ctx: BotContext): Promise<BotDecision | null>;
}

/** Last `count` speech texts visible to this seat, oldest first. */
export function recentSpeechOf(view: PlayerView, count = 5): string[] {
  const made: Extract<GameEvent, { type: 'SPEECH_MADE' }>[] = [];
  for (const event of view.log) {
    if (event.type === 'SPEECH_MADE') made.push(event);
  }
  return made.slice(-count).map((event) => event.text);
}
