import type { GameAction } from './actions';
import type { GameEvent } from './events';
import { GameError } from './errors';
import { enterDawn } from './resolution';
import type { GameState, PKState } from './state';
import { getPlayer, livingPlayers, requireVote } from './state';
import type { Seat } from './types';
import { plurality, tallyRows, tallyVotes } from './votes';

/**
 * 警长竞选 — day 1, before night deaths are announced.
 * sign-up (警上) → speeches → withdraw (退水) → 警下 vote → plurality wins;
 * tie → PK speeches → revote (tied players abstain); second tie → no sheriff.
 */

function requireElection(state: GameState) {
  if (!state.election) throw new GameError('WRONG_PHASE', 'No sheriff election is in progress.');
  return state.election;
}

function requirePhase(state: GameState, phase: 'sheriff-signup' | 'sheriff-speech'): void {
  if (state.phase !== phase) {
    throw new GameError('WRONG_PHASE', `Expected phase ${phase}, got ${state.phase}.`);
  }
}

export function handleSheriffSignup(
  state: GameState,
  action: Extract<GameAction, { type: 'SHERIFF_SIGNUP' }>,
  events: GameEvent[],
): void {
  requirePhase(state, 'sheriff-signup');
  const el = requireElection(state);
  const p = getPlayer(state, action.actor);
  if (!p.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot run for sheriff.');
  if (el.candidates.includes(action.actor)) {
    throw new GameError('ALREADY_DONE', 'Already a candidate.');
  }
  el.candidates.push(action.actor);
  events.push({ type: 'SHERIFF_SIGNUP_MADE', seat: action.actor });
}

export function handleSheriffWithdraw(
  state: GameState,
  action: Extract<GameAction, { type: 'SHERIFF_WITHDRAW' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'sheriff-signup' && state.phase !== 'sheriff-speech') {
    throw new GameError('WRONG_PHASE', 'Too late to withdraw — voting has begun.');
  }
  const el = requireElection(state);
  const idx = el.candidates.indexOf(action.actor);
  if (idx === -1) {
    throw new GameError('NOT_YOUR_TURN', 'You are not a sheriff candidate.');
  }
  el.candidates.splice(idx, 1);
  const qIdx = el.speechQueue.indexOf(action.actor);
  if (qIdx !== -1) {
    el.speechQueue.splice(qIdx, 1);
    // Withdrawing before your slot shifts the queue up; the current slot stays.
    if (qIdx < el.speechCursor) el.speechCursor -= 1;
  }
  events.push({ type: 'SHERIFF_WITHDREW', seat: action.actor });
}

/** PROCEED with signup open closes it; an empty podium voids the election. */
export function closeSheriffSignup(state: GameState, events: GameEvent[]): void {
  requirePhase(state, 'sheriff-signup');
  const el = requireElection(state);
  if (el.candidates.length === 0) {
    noSheriff(state, events);
    return;
  }
  el.speechQueue = [...el.candidates].sort((a, b) => a - b);
  el.speechCursor = 0;
  state.phase = 'sheriff-speech';
}

/** PROCEED ends the current candidate's speech slot. */
export function advanceSheriffSpeech(state: GameState, events: GameEvent[]): void {
  requirePhase(state, 'sheriff-speech');
  const el = requireElection(state);
  el.speechCursor += 1;
  if (el.speechCursor < el.speechQueue.length) return;
  if (el.candidates.length === 0) {
    noSheriff(state, events);
    return;
  }
  const electorate = livingPlayers(state)
    .map((p) => p.seat)
    .filter((s) => !el.candidates.includes(s));
  if (electorate.length === 0) {
    noSheriff(state, events);
    return;
  }
  el.electorate = electorate;
  state.vote = { kind: 'sheriff', votes: {}, electorate, revote: false };
  state.phase = 'sheriff-vote';
}

export function handleSheriffVote(
  state: GameState,
  action: Extract<GameAction, { type: 'SHERIFF_VOTE' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'sheriff-vote' && state.phase !== 'pk-vote') {
    throw new GameError('WRONG_PHASE', 'No sheriff vote is in progress.');
  }
  const el = requireElection(state);
  const vote = requireVote(state, 'sheriff');
  const voter = getPlayer(state, action.actor);
  if (!voter.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot vote.');
  if (!vote.electorate.includes(action.actor)) {
    throw new GameError('NO_VOTE_RIGHTS', 'Only 警下 players vote for sheriff.');
  }
  // A cast ballot is final — the wolf kill's latest-wins semantics do not
  // extend to public ballots.
  if (vote.votes[action.actor] !== undefined) {
    throw new GameError('ALREADY_DONE', 'A cast ballot is final.');
  }
  if (action.target !== null && !el.candidates.includes(action.target)) {
    throw new GameError('INVALID_TARGET', 'Vote for a standing candidate or abstain.');
  }
  vote.votes[action.actor] = action.target;
  events.push({ type: 'SHERIFF_VOTE_CAST', actor: action.actor, target: action.target });
  if (vote.electorate.every((s) => vote.votes[s] !== undefined)) {
    resolveSheriffVote(state, events, vote.revote);
  }
}

/** Elects on unique plurality; first-ballot ties go to PK, second ties void. */
export function resolveSheriffVote(state: GameState, events: GameEvent[], revote: boolean): void {
  const vote = requireVote(state, 'sheriff');
  const { counts, abstains } = tallyVotes(state, vote.votes);
  events.push({ type: 'VOTE_TALLY', kind: 'sheriff', counts: tallyRows(counts, abstains) });
  const result = plurality(counts);
  state.vote = null;
  if (result.winner !== null) {
    electSheriff(state, result.winner, events);
    return;
  }
  if (revote || result.tied.length < 2) {
    noSheriff(state, events);
    return;
  }
  const pk: PKState = {
    kind: 'sheriff',
    tied: result.tied,
    cursor: 0,
    electorate: vote.electorate,
  };
  state.pk = pk;
  state.phase = 'pk-speech';
}

function electSheriff(state: GameState, seat: Seat, events: GameEvent[]): void {
  const p = getPlayer(state, seat);
  p.hasBadge = true;
  state.election = null;
  events.push({ type: 'SHERIFF_ELECTED', seat });
  enterDawn(state, events);
}

export function noSheriff(state: GameState, events: GameEvent[]): void {
  events.push({ type: 'NO_SHERIFF' });
  state.election = null;
  enterDawn(state, events);
}
