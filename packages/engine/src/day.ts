import type { GameAction } from './actions';
import type { GameEvent } from './events';
import { GameError } from './errors';
import { afterDawn, applyDeath, drainResolution, enterNight, enterSpeech } from './resolution';
import type { GameState } from './state';
import { getPlayer, livingPlayers, requireLivingTarget, requireVote } from './state';
import { canVote, type Phase, type Seat } from './types';
import { plurality, tallyBallots, tallyRows, tallyVotes } from './votes';

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
  else afterDawn(state, events);
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
  // A cast ballot is final — a retry or double-click must not silently
  // rewrite the tally (EXILE_VOTE_CAST is server-visible only, so a rewrite
  // would be invisible to players).
  if (vote.votes[action.actor] !== undefined) {
    throw new GameError('ALREADY_DONE', 'A cast ballot is final.');
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
  events.push({
    type: 'VOTE_TALLY',
    kind: 'exile',
    revote: vote.revote,
    counts: tallyRows(counts, abstains),
    ballots: tallyBallots(state, vote.votes),
  });
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
  // Idiot branches are board-conditional by construction: boards without the
  // idiot never seat one, so these checks are unreachable there — kept, not
  // deleted, per the board-registry contract.
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

export function advancePkSpeech(state: GameState, events: GameEvent[]): void {
  if (state.phase !== 'pk-speech' || !state.pk) {
    throw new GameError('WRONG_PHASE', 'No PK speech is in progress.');
  }
  const pk = state.pk;
  pk.cursor += 1;
  if (pk.cursor < pk.tied.length) return;
  // A revote whose electorate is empty is vacuous: the tied players abstain
  // by rule, so when they are every voter nobody can cast a legal vote and
  // no timer default can advance the phase — the room would freeze. The tie
  // stands; the day ends with no exile, like any revote tie.
  if (pk.electorate.length === 0) {
    state.pk = null;
    enterNight(state, events);
    return;
  }
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

/**
 * The 白狼王 self-destructs — during the day's speech rounds (voluntarily)
 * or at his own exile settlement (the death window). He reveals, dies, takes
 * his target with him, and the day ends immediately: night falls after the
 * interrupt queue drains. Poison and the night kill silence him — a dead
 * king has no voice, and his death record opens no window for those causes.
 */
export function handleWolfKingDestruct(
  state: GameState,
  action: Extract<GameAction, { type: 'WOLF_KING_DESTRUCT' }>,
  events: GameEvent[],
): void {
  const actor = getPlayer(state, action.actor);
  const settlementHead = state.phase === 'hunter-shot' ? state.resolution?.queue[0] : undefined;
  const settlementWindow =
    settlementHead !== undefined &&
    settlementHead.seat === action.actor &&
    settlementHead.destructWindow &&
    !settlementHead.destructWindowDone;
  // A dead king may still fire exactly one window — his own exile settlement,
  // the same privilege a dying hunter's shot gets.
  if (!actor.alive && !settlementWindow) {
    throw new GameError('PLAYER_DEAD', 'Dead players cannot act.');
  }
  if (actor.role !== 'white_wolf_king') {
    throw new GameError('NOT_YOUR_TURN', 'Only the 白狼王 self-destructs.');
  }
  const priv = actor.private;
  if (priv.kind !== 'white_wolf_king' || priv.destructUsed) {
    throw new GameError('ALREADY_DONE', 'The self-destruct has already been used.');
  }
  if (!settlementWindow && state.phase !== 'speech' && state.phase !== 'pk-speech') {
    throw new GameError('WRONG_PHASE', 'No 白狼王 destruct window is open.');
  }
  if (action.target === action.actor) {
    throw new GameError('INVALID_TARGET', 'The 白狼王 cannot take himself.');
  }
  const target = requireLivingTarget(state, action.target);

  priv.destructUsed = true;
  if (settlementWindow) settlementHead.destructWindowDone = true;
  events.push({ type: 'WHITE_WOLF_KING_DESTRUCTED', actor: action.actor, target: target.seat });

  // 双爆吞警徽: the Nth destruct destroys the badge instead of passing it
  // (0 disables the rule). One king cannot reach 2 in a legal game — the
  // knob exists for house variants that let more wolves self-destruct.
  const prior = state.log.filter((e) => e.type === 'WHITE_WOLF_KING_DESTRUCTED').length;
  const swallow =
    state.config.destructBadgeSwallow > 0 && prior + 1 === state.config.destructBadgeSwallow;

  // At the settlement his death already stands (the exile); mid-speech he
  // dies by his own hand.
  const kingRecord = settlementWindow
    ? settlementHead
    : applyDeath(state, action.actor, 'self-destruct', events);
  const targetRecord = applyDeath(state, target.seat, 'self-destruct', events);
  if (swallow) {
    for (const record of [kingRecord, targetRecord]) {
      if (!record.badgePass) continue;
      record.badgePass = false;
      record.badgeDone = true;
      getPlayer(state, record.seat).hasBadge = false;
      events.push({ type: 'BADGE_DESTROYED', from: record.seat });
    }
  }

  if (settlementWindow) {
    // The exile settlement's queue already exists — the taken player's
    // interrupts (badge, hunter shot) cascade from it.
    state.resolution?.queue.push(targetRecord);
    drainResolution(state, events);
    return;
  }
  // Mid-speech: the day ends immediately — night falls after interrupts.
  state.resolution = {
    origin: 'day',
    queue: [kingRecord, targetRecord],
    newDeaths: true,
  };
  drainResolution(state, events);
}

export function handleWolfKingPass(
  state: GameState,
  action: Extract<GameAction, { type: 'WOLF_KING_PASS' }>,
  events: GameEvent[],
): void {
  if (state.phase !== 'hunter-shot') {
    throw new GameError('WRONG_PHASE', 'No 白狼王 destruct window is open.');
  }
  const head = interruptHead(state);
  if (head.seat !== action.actor || !head.destructWindow || head.destructWindowDone) {
    throw new GameError('NOT_YOUR_TURN', 'No destruct window is open for you.');
  }
  head.destructWindowDone = true;
  events.push({ type: 'WOLF_KING_PASSED', actor: action.actor });
  drainResolution(state, events);
}

// — wolf explode (狼人自爆) —

/** A plain wolf may reveal and die only while a voice is live: the signup
 *  window and every speech phase. Ballots are simultaneous — never
 *  interrupted, so no vote phase ever opens the window. */
const EXPLODE_WINDOWS: readonly Phase[] = [
  'sheriff-signup',
  'sheriff-speech',
  'speech',
  'pk-speech',
];

/**
 * 狼人自爆 — a plain wolf (badge held or not) reveals and self-destructs with
 * no target. The 白狼王 keeps his targeted destruct and cannot use this. The
 * day ends immediately: after the explosion's own settlement drains (a
 * wolf-sheriff's badge window runs first), night falls — on day 1 the
 * buffered night deaths release through the dawn announcements first. The
 * 双爆吞警徽 knob stays scoped to the 白狼王's destructs; a plain explode
 * never swallows a badge.
 */
export function handleWolfExplode(
  state: GameState,
  action: Extract<GameAction, { type: 'WOLF_EXPLODE' }>,
  events: GameEvent[],
): void {
  const actor = getPlayer(state, action.actor);
  if (!actor.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot act.');
  if (actor.role !== 'werewolf') {
    throw new GameError(
      'NOT_YOUR_TURN',
      'Only a plain wolf explodes — the 白狼王 destructs with a target.',
    );
  }
  if (!EXPLODE_WINDOWS.includes(state.phase)) {
    throw new GameError('WRONG_PHASE', 'No wolf explode window is open.');
  }
  // The death is public through this event — never a DEATH_ANNOUNCED (same
  // convention as the 白狼王's destruct).
  events.push({ type: 'WOLF_EXPLODED', seat: action.actor });
  const record = applyDeath(state, action.actor, 'self-destruct', events);
  // The explosion rips up the election — platform, speeches, ballot all void.
  state.election = null;
  state.resolution = { origin: 'explode', queue: [record], newDeaths: true };
  drainResolution(state, events);
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
  // A shot death is a brand-new death: arm the win-check gate. Day-origin
  // resolutions already carry newDeaths = true, so this is a no-op there —
  // and on the dawn path it is the difference between GAME_OVER and a
  // wolfless night no legal action can leave.
  if (state.resolution) state.resolution.newDeaths = true;
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
