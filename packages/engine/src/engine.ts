import type { GameAction } from './actions';
import type { GameEvent } from './events';
import { GameError } from './errors';
import {
  handleGuardPass,
  handleGuardProtect,
  handleSeerCheck,
  handleSeerPass,
  handleStartGame,
  handleWitchHeal,
  handleWitchPass,
  handleWitchPoison,
  handleWolfKill,
} from './night';
import {
  announceNext,
  advanceLastWords,
  advancePkSpeech,
  advanceSpeech,
  handleExileVote,
  handleHunterPass,
  handleHunterShoot,
  handleSetSpeechDirection,
  handleSheriffPass,
  handleSpeak,
} from './day';
import { deepClone, type GameState } from './state';
import {
  advanceSheriffSpeech,
  closeSheriffSignup,
  handleSheriffSignup,
  handleSheriffVote,
  handleSheriffWithdraw,
} from './sheriff';

export interface AppliedAction {
  /** The new state — the input is never mutated. */
  state: GameState;
  /** Events emitted by this action, in order. */
  events: GameEvent[];
}

/**
 * The rules engine: a pure reducer from (state, action) to (state, events).
 *
 * - Zero I/O and fully deterministic — replaying the same actions from
 *   `createGame` reproduces the same states and event log.
 * - Illegal actions throw `GameError`; the server maps the code onto a
 *   per-socket rejection. The input state is never mutated by a failed (or
 *   successful) application.
 * - The win condition is evaluated exactly once per resolution step, never
 *   mid-action.
 */
export function applyAction(state: GameState, action: GameAction): AppliedAction {
  if (state.phase === 'game-over' || state.winner) {
    throw new GameError('WRONG_PHASE', 'The game is over.');
  }
  const next = deepClone(state);
  const events: GameEvent[] = [];
  route(next, action, events);
  for (const event of events) next.log.push(event);
  return { state: next, events };
}

function route(state: GameState, action: GameAction, events: GameEvent[]): void {
  switch (action.type) {
    case 'START_GAME':
      handleStartGame(state, events);
      return;
    case 'PROCEED':
      handleProceed(state, events);
      return;
    case 'WOLF_KILL':
      handleWolfKill(state, action, events);
      return;
    case 'GUARD_PROTECT':
      handleGuardProtect(state, action, events);
      return;
    case 'GUARD_PASS':
      handleGuardPass(state, action, events);
      return;
    case 'WITCH_HEAL':
      handleWitchHeal(state, action, events);
      return;
    case 'WITCH_POISON':
      handleWitchPoison(state, action, events);
      return;
    case 'WITCH_PASS':
      handleWitchPass(state, action, events);
      return;
    case 'SEER_CHECK':
      handleSeerCheck(state, action, events);
      return;
    case 'SEER_PASS':
      handleSeerPass(state, action, events);
      return;
    case 'SHERIFF_SIGNUP':
      handleSheriffSignup(state, action, events);
      return;
    case 'SHERIFF_WITHDRAW':
      handleSheriffWithdraw(state, action, events);
      return;
    case 'SHERIFF_VOTE':
      handleSheriffVote(state, action, events);
      return;
    case 'SHERIFF_PASS':
      handleSheriffPass(state, action, events);
      return;
    case 'SPEAK':
      handleSpeak(state, action, events);
      return;
    case 'EXILE_VOTE':
      handleExileVote(state, action, events);
      return;
    case 'HUNTER_SHOOT':
      handleHunterShoot(state, action, events);
      return;
    case 'HUNTER_PASS':
      handleHunterPass(state, action, events);
      return;
    case 'SET_SPEECH_DIRECTION':
      handleSetSpeechDirection(state, action, events);
      return;
    default: {
      const exhaustive: never = action;
      throw new GameError('WRONG_PHASE', `Unhandled action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function handleProceed(state: GameState, events: GameEvent[]): void {
  switch (state.phase) {
    case 'sheriff-signup':
      closeSheriffSignup(state, events);
      return;
    case 'sheriff-speech':
      advanceSheriffSpeech(state, events);
      return;
    case 'dawn-announce':
      announceNext(state, events);
      return;
    case 'last-words':
      advanceLastWords(state);
      return;
    case 'speech':
      advanceSpeech(state);
      return;
    case 'pk-speech':
      advancePkSpeech(state);
      return;
    default:
      throw new GameError('WRONG_PHASE', `Nothing to proceed past in phase ${state.phase}.`);
  }
}
