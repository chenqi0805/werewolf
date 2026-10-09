import type { GameAction } from './actions';
import type { GameEvent } from './events';
import { GameError } from './errors';
import { afterDawn, applyDeath, drainResolution, enterNight, enterSpeech } from './resolution';
import type { GameState } from './state';
import { getPlayer, livingPlayers, requireLivingTarget, requireVote } from './state';
import { canVote, type Seat } from './types';
import { plurality, tallyRows, tallyVotes } from './votes';

// — dawn ————————————————————————————————————————————————————————————————

/** PROCEED pops the next announcement; deaths in seat order, cause hidden. */
export function announceNext(state: GameState, events: GameEvent[]): void {
  if (state.phase !== 'dawn-announce' || !state.dawn) {
    throw new GameError('WRONG_PHASE', 'No dawn announcement is in progress.');
  }
  const dawn = state.dawn;
  const head = dawn.pending.shift();
  if (!head) {
    finishDawn(state, events);
    return;
  }
  if (head === 'peace') {
    events.push({ type: 'PEACEFUL_NIGHT' });
  } else {
    head.announced = true;
    dawn.announced.push(head);
    events.push({ type: 'DEATH_ANNOUNCED', seat: head.seat });
    state.resolution ??= { origin: 'dawn', queue: [], newDeaths: false };
    state.resolution.queue.push(head);
  }
  if (dawn.pending.length === 0) finishDawn(state, events);
}

function finishDawn(state: GameState, events: GameEvent[]): void {
  if (state.resolution) drainResolution(state, events);
  else afterDawn(state);
}

// — last words ——————————————————————————————————————————————————————————

export function advanceLastWords(state: GameState): void {
  if (state.phase !== 'last-words' || !state.lastWords) {
    throw new GameError('WRONG_PHASE', 'No last words are in progress.');
  }
  const lw = state.lastWords;
  lw.cursor += 1;
  if (lw.cursor < lw.queue.length) return;
  state.lastWords = null;
  enterSpeech(state);
}

// — speech round ————————————————————————————————————————————————————————
// Speeches are public; every living player speaks once, the revealed idiot
// included. The sheriff sets the daily direction before the first slot.

export function handleSpeak(
  state: GameState,
  action: Extract<GameAction, { type: 'SPEAK' }>,
  events: GameEvent[],
): void {
  const { actor, text } = action;
  if (state.phase === 'sheriff-speech') {
    const el = requireElection(state);
    const expected = el.speechQueue[el.speechCursor];
    if (expected !== actor) {
      throw new GameError('NOT_YOUR_TURN', `It is seat ${expected}’s speech slot.`);
    }
    events.push({ type: 'SPEECH_MADE', seat: actor, text, context: 'sheriff-speech' });
    return;
  }
  if (state.phase === 'last-words') {
    const lw = state.lastWords;
    if (!lw) throw new GameError('WRONG_PHASE', 'No last words are in progress.');
    const expected = lw.queue[lw.cursor];
    if (expected !== actor) {
      throw new GameError('NOT_YOUR_TURN', `It is seat ${expected}’s last words.`);
    }
    events.push({ type: 'SPEECH_MADE', seat: actor, text, context: 'last-words' });
    return;
  }
  if (state.phase === 'speech') {
    const sp = state.speech;
    if (!sp || sp.order === null) {
      throw new GameError('WRONG_PHASE', 'The sheriff has not set the speech direction.');
    }
    const expected = sp.order[sp.cursor];
    if (expected !== actor) {
      throw new GameError('NOT_YOUR_TURN', `It is seat ${expected}’s speech slot.`);
    }
    events.push({ type: 'SPEECH_MADE', seat: actor, text, context: 'speech' });
    return;
  }
  if (state.phase === 'pk-speech') {
    const pk = state.pk;
    if (!pk) throw new GameError('WRONG_PHASE', 'No PK speech is in progress.');
    const expected = pk.tied[pk.cursor];
    if (expected !== actor) {
      throw new GameError('NOT_YOUR_TURN', `It is seat ${expected}’s PK speech.`);
    }
    events.push({ type: 'SPEECH_MADE', seat: actor, text, context: 'pk-speech' });
    return;
  }
  throw new GameError('WRONG_PHASE', 'No speech slot is open.');
}

function requireElection(state: GameState) {
  if (!state.election) throw new GameError('WRONG_PHASE', 'No sheriff election is in progress.');
  return state.election;
}

/** Direction: cw = ascending seats from the sheriff's first successor. */
export function speechOrderFor(
  living: Seat[],
  sheriff: Seat,
  direction: 'cw' | 'ccw',
  sheriffSpeaksFirst: boolean,
): Seat[] {
  const seq = direction === 'cw' ? living : [...living].reverse();
  const at = seq.indexOf(sheriff);
  const offset = sheriffSpeaksFirst ? at : at + 1;
  return [...seq, ...seq].slice(offset, offset + seq.length);
}

export function handleSetSpeechDirection(
  state: GameState,
  action: Extract<GameAction, { type: 'SET_SPEECH_DIRECTION' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'speech' || !state.speech) {
    throw new GameError('WRONG_PHASE', 'The speech round is not open.');
  }
  const sp = state.speech;
  if (sp.order !== null) throw new GameError('ALREADY_DONE', 'Speech direction already set.');
  const sheriff = livingPlayers(state).find((p) => p.hasBadge);
  if (!sheriff || sheriff.seat !== action.actor) {
    throw new GameError('NOT_YOUR_TURN', 'Only the sheriff sets the speech direction.');
  }
  sp.order = speechOrderFor(
    livingPlayers(state).map((p) => p.seat),
    sheriff.seat,
    action.direction,
    state.config.sheriffSpeaksFirst,
  );
  events.push({ type: 'SPEECH_ORDER_SET', direction: action.direction, order: sp.order });
}

export function advanceSpeech(state: GameState): void {
  if (state.phase !== 'speech' || !state.speech) {
    throw new GameError('WRONG_PHASE', 'No speech round is in progress.');
  }
  const sp = state.speech;
  if (sp.order === null) {
    throw new GameError('WRONG_PHASE', 'The sheriff has not set the speech direction.');
  }
  sp.cursor += 1;
  if (sp.cursor < sp.order.length) return;
  openExileVote(state);
}

function openExileVote(state: GameState): void {
  state.speech = null;
  const electorate = livingPlayers(state)
    .filter((p) => canVote(p))
    .map((p) => p.seat);
  state.vote = { kind: 'exile', votes: {}, electorate, revote: false };
  state.phase = 'exile-vote';
}

// — exile vote ——————————————————————————————————————————————————————————

export function handleExileVote(
  state: GameState,
  action: Extract<GameAction, { type: 'EXILE_VOTE' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'exile-vote' && state.phase !== 'pk-vote') {
    throw new GameError('WRONG_PHASE', 'No exile vote is in progress.');
  }
  const vote = requireVote(state, 'exile');
  const voter = getPlayer(state, action.actor);
  if (!voter.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot vote.');
  if (!vote.electorate.includes(action.actor)) {
    throw new GameError('NO_VOTE_RIGHTS', 'You have no vote rights.');
  }
  if (action.target !== null) requireLivingTarget(state, action.target);
  vote.votes[action.actor] = action.target;
  events.push({ type: 'EXILE_VOTE_CAST', actor: action.actor, target: action.target });
  if (vote.electorate.every((s) => vote.votes[s] !== undefined)) {
    resolveExileVote(state, events, vote.revote);
  }
}

export function resolveExileVote(state: GameState, events: GameEvent[], revote: boolean): void {
  const vote = requireVote(state, 'exile');
  const { counts, abstains } = tallyVotes(state, vote.votes);
  events.push({ type: 'VOTE_TALLY', kind: 'exile', counts: tallyRows(counts, abstains) });
  const result = plurality(counts);
  state.vote = null;
  if (result.winner !== null) {
    resolveExileTarget(state, result.winner, events);
    return;
  }
  if (revote || result.tied.length < 2) {
    enterNight(state, events);
    return;
  }
  state.pk = {
    kind: 'exile',
    tied: result.tied,
    cursor: 0,
    // The tied players may not vote in the revote.
    electorate: vote.electorate.filter((s) => !result.tied.includes(s)),
  };
  state.phase = 'pk-speech';
}

function resolveExileTarget(state: GameState, seat: Seat, events: GameEvent[]): void {
  const p = getPlayer(state, seat);
  if (p.revealedIdiot && state.config.idiotUnexilableAfterReveal) {
    events.push({ type: 'EXILE_BLOCKED_BY_IDIOT', seat });
    enterNight(state, events);
    return;
  }
  if (p.role === 'idiot' && !p.revealedIdiot) {
    // First exile lands on the idiot: reveal, survive, lose vote rights.
    p.revealedIdiot = true;
    events.push({ type: 'IDIOT_REVEALED', seat });
    enterNight(state, events);
    return;
  }
  events.push({ type: 'PLAYER_EXILED', seat });
  const record = applyDeath(state, seat, 'exile', events);
  state.resolution = { origin: 'day', queue: [record], newDeaths: true };
  drainResolution(state, events);
}

// — PK speeches and revote ——————————————————————————————————————————————

export function advancePkSpeech(state: GameState): void {
  if (state.phase !== 'pk-speech' || !state.pk) {
    throw new GameError('WRONG_PHASE', 'No PK speech is in progress.');
  }
  const pk = state.pk;
  pk.cursor += 1;
  if (pk.cursor < pk.tied.length) return;
  state.vote = { kind: pk.kind, votes: {}, electorate: pk.electorate, revote: true };
  state.pk = null;
  state.phase = 'pk-vote';
}

// — hunter shot and badge pass interrupts ———————————————————————————————

function interruptHead(state: GameState) {
  const head = state.resolution?.queue[0];
  if (!head) throw new GameError('WRONG_PHASE', 'No interrupt is in progress.');
  return head;
}

export function handleHunterShoot(
  state: GameState,
  action: Extract<GameAction, { type: 'HUNTER_SHOOT' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'hunter-shot') {
    throw new GameError('NOT_ELIGIBLE_SHOOTER', 'No hunter shot window is open.');
  }
  const head = interruptHead(state);
  if (head.seat !== action.actor) {
    throw new GameError('NOT_YOUR_TURN', 'You are not the dying hunter.');
  }
  if (head.hunterWindowDone) {
    throw new GameError('NOT_ELIGIBLE_SHOOTER', 'The shot window has closed.');
  }
  const hunter = getPlayer(state, action.actor);
  if (hunter.private.kind !== 'hunter') {
    throw new GameError('NOT_ELIGIBLE_SHOOTER', 'Only the hunter shoots.');
  }
  if (action.target === action.actor) {
    throw new GameError('INVALID_TARGET', 'The hunter cannot shoot himself.');
  }
  requireLivingTarget(state, action.target);
  hunter.private.shotUsed = true;
  head.hunterWindowDone = true;
  events.push({ type: 'HUNTER_SHOT', shooter: action.actor, target: action.target });
  // The shot target dies immediately, with no last words.
  const record = applyDeath(state, action.target, 'shot', events);
  state.resolution?.queue.push(record);
  drainResolution(state, events);
}

export function handleHunterPass(
  state: GameState,
  action: Extract<GameAction, { type: 'HUNTER_PASS' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'hunter-shot') {
    throw new GameError('NOT_ELIGIBLE_SHOOTER', 'No hunter shot window is open.');
  }
  const head = interruptHead(state);
  if (head.seat !== action.actor) {
    throw new GameError('NOT_YOUR_TURN', 'You are not the dying hunter.');
  }
  head.hunterWindowDone = true;
  events.push({ type: 'HUNTER_PASSED', shooter: action.actor });
  drainResolution(state, events);
}

export function handleSheriffPass(
  state: GameState,
  action: Extract<GameAction, { type: 'SHERIFF_PASS' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'badge-pass') {
    throw new GameError('WRONG_PHASE', 'No badge pass is in progress.');
  }
  const head = interruptHead(state);
  if (head.seat !== action.actor) {
    throw new GameError('NOT_YOUR_TURN', 'You are not the departed badge holder.');
  }
  const holder = getPlayer(state, action.actor);
  if (!holder.hasBadge) {
    throw new GameError('WRONG_PHASE', 'The badge is not held by the dying player.');
  }
  if (action.target === null) {
    holder.hasBadge = false;
    head.badgeDone = true;
    events.push({ type: 'BADGE_DESTROYED', from: action.actor });
  } else {
    const successor = requireLivingTarget(state, action.target);
    if (successor.seat === action.actor) {
      throw new GameError('PLAYER_DEAD', 'The dying holder cannot keep the badge.');
    }
    holder.hasBadge = false;
    successor.hasBadge = true;
    head.badgeDone = true;
    events.push({ type: 'BADGE_PASSED', from: action.actor, to: successor.seat });
  }
  drainResolution(state, events);
}
