import type { GameAction, GameState, PlayerAction, Role } from '@werewolf/engine';

/**
 * The timer contract: when a phase clock lapses, the server injects these
 * default actions through the same `applyAction` path a human client uses —
 * abstain, no potion, pass, or a pacing PROCEED. The engine never learns
 * timers exist, and phase-two AI bots will consume the identical deadline
 * model.
 *
 * Every returned action is legal in the current phase by construction; the
 * injected batch is computed from one state snapshot and applied in order.
 */
export function defaultActionsFor(state: GameState): GameAction[] {
  switch (state.phase) {
    case 'lobby':
    case 'game-over':
      return [];
    case 'night': {
      const night = state.night;
      if (!night) return [];
      if (night.step === 'wolf') {
        // 空刀 is the only fair default. The non-default knob (emptyKnife
        // off) has no neutral action — those wolves simply wait; v1 ships
        // with the knob on.
        if (!state.config.emptyKnife) return [];
        return livingWolves(state)
          .filter((w) => night.wolfVotes[w] === undefined)
          .map((w) => ({ type: 'WOLF_KILL', actor: w, target: null }) as PlayerAction);
      }
      if (night.step === 'witch') {
        const witch = findByRole(state, 'witch');
        return witch?.alive ? [{ type: 'WITCH_PASS', actor: witch.seat }] : [];
      }
      const seer = findByRole(state, 'seer');
      return seer?.alive ? [{ type: 'SEER_PASS', actor: seer.seat }] : [];
    }
    case 'sheriff-signup':
    case 'sheriff-speech':
    case 'dawn-announce':
    case 'last-words':
    case 'pk-speech':
      return [{ type: 'PROCEED' }];
    case 'speech': {
      // order === null means the badge holder has not chosen a direction.
      // Injecting a direction for them is the only way a vanished sheriff's
      // table keeps moving; without a living sheriff this branch is
      // unreachable (enterSpeech presets the order), so stay out of the way.
      if (state.speech?.order == null) {
        const sheriff = Object.values(state.players).find((p) => p.hasBadge && p.alive);
        return sheriff
          ? [{ type: 'SET_SPEECH_DIRECTION', actor: sheriff.seat, direction: 'cw' }]
          : [];
      }
      return [{ type: 'PROCEED' }];
    }
    case 'sheriff-vote':
    case 'exile-vote':
    case 'pk-vote': {
      const vote = state.vote;
      if (!vote) return [];
      const type = vote.kind === 'sheriff' ? 'SHERIFF_VOTE' : 'EXILE_VOTE';
      return vote.electorate
        .filter((s) => vote.votes[s] === undefined)
        .map((s) => ({ type, actor: s, target: null }) as PlayerAction);
    }
    case 'hunter-shot': {
      const head = state.resolution?.queue[0];
      return head ? [{ type: 'HUNTER_PASS', actor: head.seat }] : [];
    }
    case 'badge-pass': {
      // 撕毁 — a vanished holder does not hand the badge to anyone.
      const head = state.resolution?.queue[0];
      return head ? [{ type: 'SHERIFF_PASS', actor: head.seat, target: null }] : [];
    }
  }
}

/** Timer identity for the current state: null where no clock should run. */
export function clockKey(state: GameState): string | null {
  switch (state.phase) {
    case 'lobby':
    case 'game-over':
      return null;
    case 'night':
      return `night:${state.night?.step ?? 'wolf'}`;
    default:
      return state.phase;
  }
}

/** Default pacing per clock key. Tests override these with milliseconds. */
export const DEFAULT_TIMERS: Record<string, number> = {
  'night:wolf': 30_000,
  'night:witch': 30_000,
  'night:seer': 25_000,
  'sheriff-signup': 20_000,
  'sheriff-speech': 45_000,
  'sheriff-vote': 30_000,
  'dawn-announce': 10_000,
  'last-words': 60_000,
  speech: 75_000,
  'exile-vote': 45_000,
  'pk-speech': 45_000,
  'pk-vote': 30_000,
  'hunter-shot': 20_000,
  'badge-pass': 15_000,
};

function livingWolves(state: GameState): number[] {
  return Object.values(state.players)
    .filter((p) => p.alive && p.role === 'werewolf')
    .map((p) => p.seat)
    .sort((a, b) => a - b);
}

function findByRole(state: GameState, role: Role) {
  return Object.values(state.players).find((p) => p.role === role);
}
