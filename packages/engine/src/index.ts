/**
 * @werewolf/engine — the entire rulebook as a pure reducer.
 *
 * Zero I/O: no sockets, timers, persistence, or rendering. The server owns
 * transport, pacing, and per-seat view projection; the client renders views
 * and submits actions. This surface is also the seam phase-two AI-bot players
 * plug into — a bot is just another producer of `PlayerAction`.
 */
export type { Camp, Phase, PrivateState, PlayerState, Role, Seat, SeatAssignment } from './types';
export { canVote, GOD_ROLES, SEAT_COUNT, campOf } from './types';

export type { BoardId, BoardDefinition, NightStep } from './boards';
export { BOARDS } from './boards';

export type { EngineConfig, WolfKingDestructWindow } from './config';
export { DEFAULT_CONFIG } from './config';

export type { GameAction, PlayerAction, ServerAction } from './actions';
export type { GameEvent, EventVisibility, TallyRow } from './events';
export { visibilityOf } from './events';

export type {
  DawnState,
  DeathCause,
  DeathRecord,
  ElectionState,
  GameState,
  LastWordsState,
  NightState,
  PKState,
  ResolutionState,
  SpeechState,
  VoteState,
} from './state';

export type { GameErrorCode } from './errors';
export { GameError } from './errors';

export { createGame } from './create';
export { applyAction, type AppliedAction } from './engine';

// Rule helpers the server and future bot framework may reuse.
export { voteWeight, tallyVotes, tallyRows, type Plurality } from './votes';
export { winCheck } from './resolution';
