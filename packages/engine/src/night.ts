import type { GameAction } from './actions';
import type { GameEvent } from './events';
import { GameError } from './errors';
import { completeNight } from './resolution';
import type { GameState, NightState } from './state';
import {
  findRole,
  freshNight,
  getPlayer,
  livingPlayers,
  requireLivingTarget,
  requireNight,
} from './state';
import type { Seat } from './types';
import { campOf } from './types';
import { plurality } from './votes';

/**
 * Opens night 1. On guard-first boards (nightOrder[0] === 'guard') the fresh
 * night waits on the guard before the wolves; the classic order is unchanged.
 */
export function handleStartGame(state: GameState, events: GameEvent[]): void {
  if (state.phase !== 'lobby') {
    throw new GameError('WRONG_PHASE', 'The game has already started.');
  }
  state.phase = 'night';
  state.night = freshNight(state);
  events.push({ type: 'GAME_STARTED' });
  events.push({ type: 'NIGHT_BEGAN', dayNumber: state.dayNumber });
}

/** True while the night is waiting on the guard's decision. */
export function guardTurnPending(state: GameState): boolean {
  return state.night?.guardTurn === 'pending';
}

/**
 * The guard protects one player (possibly himself) from tonight's wolf kill.
 * Protection is registered on the night state; the kill-vs-heal-vs-poison
 * combinatorics resolve in computeNightDeaths at dawn.
 */
export function handleGuardProtect(
  state: GameState,
  action: Extract<GameAction, { type: 'GUARD_PROTECT' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.guardTurn !== 'pending') {
    throw new GameError('NOT_YOUR_TURN', 'It is not the guard’s turn.');
  }
  const actor = getPlayer(state, action.actor);
  if (!actor.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot act.');
  if (actor.role !== 'guard') {
    throw new GameError('NOT_YOUR_TURN', 'Only the guard protects at night.');
  }
  const target = requireLivingTarget(state, action.target);
  if (!state.config.guardSelfProtect && target.seat === actor.seat) {
    throw new GameError('INVALID_TARGET', '自守 is disabled; the guard cannot protect himself.');
  }
  // 连守 reads lastProtected — last night's choice — never tonight's.
  if (state.config.guardRepeatBan && state.lastProtected === target.seat) {
    throw new GameError(
      'INVALID_TARGET',
      '连守 — the guard cannot protect the same player two nights running.',
    );
  }
  night.protectTarget = target.seat;
  night.guardTurn = 'done';
  events.push({ type: 'GUARD_PROTECTED', actor: actor.seat, target: target.seat });
}

export function handleGuardPass(
  state: GameState,
  action: Extract<GameAction, { type: 'GUARD_PASS' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.guardTurn !== 'pending') {
    throw new GameError('NOT_YOUR_TURN', 'It is not the guard’s turn.');
  }
  const actor = getPlayer(state, action.actor);
  if (!actor.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot act.');
  if (actor.role !== 'guard') {
    throw new GameError('NOT_YOUR_TURN', 'Only the guard protects at night.');
  }
  if (!state.config.guardEmptyProtect) {
    throw new GameError('INVALID_TARGET', '空守 is disabled; the guard must protect someone.');
  }
  night.guardTurn = 'done';
  events.push({ type: 'GUARD_PASSED', actor: actor.seat });
}

export function handleWolfKill(
  state: GameState,
  action: Extract<GameAction, { type: 'WOLF_KILL' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.step !== 'wolf') {
    throw new GameError('NOT_YOUR_TURN', 'The wolves have finished acting tonight.');
  }
  if (night.guardTurn === 'pending') {
    throw new GameError('NOT_YOUR_TURN', 'The guard has not finished acting tonight.');
  }
  const actor = getPlayer(state, action.actor);
  if (!actor.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot act.');
  if (campOf(actor.role) !== 'wolf') {
    throw new GameError('NOT_YOUR_TURN', 'Only wolves vote for the night kill.');
  }
  if (action.target !== null) {
    requireLivingTarget(state, action.target);
  } else if (!state.config.emptyKnife) {
    throw new GameError('INVALID_TARGET', '空刀 is disabled; the wolves must pick a target.');
  }
  night.wolfVotes[action.actor] = action.target;
  events.push({ type: 'WOLF_KILL_VOTE', actor: action.actor, target: action.target });
  const livingWolves = livingPlayers(state).filter((p) => campOf(p.role) === 'wolf');
  if (livingWolves.every((w) => night.wolfVotes[w.seat] !== undefined)) {
    resolveWolfVote(state, night, events);
  }
}

/**
 * Unique plurality among wolf votes — `null` (空刀) competes as an option, so
 * a split vote or a null majority yields 平安夜. One wolf decides alone.
 */
function resolveWolfVote(state: GameState, night: NightState, events: GameEvent[]): void {
  const counts = new Map<Seat | null, number>();
  for (const key of Object.keys(night.wolfVotes)) {
    const target = night.wolfVotes[Number(key)];
    if (target === undefined) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const result = plurality(counts);
  night.killTarget = result.winner;
  events.push({ type: 'KILL_TARGET_SET', target: result.winner });
  advanceNightStep(state, events);
}

function advanceNightStep(state: GameState, events: GameEvent[]): void {
  const night = requireNight(state);
  if (night.step === 'wolf') {
    night.step = 'witch';
    const witch = findRole(state, 'witch');
    if (!witch || !witch.alive) advanceNightStep(state, events);
    return;
  }
  if (night.step === 'witch') {
    night.step = 'seer';
    const seer = findRole(state, 'seer');
    if (!seer || !seer.alive) completeNight(state, events);
  }
}

function witchPrivate(state: GameState, seat: Seat) {
  const p = getPlayer(state, seat);
  if (p.private.kind !== 'witch') {
    throw new GameError('NOT_YOUR_TURN', 'Seat is not the witch.');
  }
  return { player: p, potions: p.private };
}

export function handleWitchHeal(
  state: GameState,
  action: Extract<GameAction, { type: 'WITCH_HEAL' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.step !== 'witch') {
    throw new GameError('NOT_YOUR_TURN', 'It is not the witch’s turn.');
  }
  const { player: witch, potions } = witchPrivate(state, action.actor);
  if (night.killTarget === null) {
    throw new GameError('WRONG_PHASE', 'No one was attacked tonight; there is nothing to heal.');
  }
  if (potions.healUsed) throw new GameError('POTION_USED', 'The heal potion is spent.');
  if (night.killTarget === witch.seat && !night.maySelfSave) {
    throw new GameError('POTION_SELF_SAVE', 'Self-save is only allowed on night 1.');
  }
  if (!state.config.witchDoublePotion && night.poisonUsedTonight) {
    throw new GameError('NOT_YOUR_TURN', 'Only one potion may be used tonight.');
  }
  potions.healUsed = true;
  night.healUsedTonight = true;
  night.healed = true;
  events.push({ type: 'WITCH_HEALED', actor: witch.seat, target: night.killTarget });
}

export function handleWitchPoison(
  state: GameState,
  action: Extract<GameAction, { type: 'WITCH_POISON' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.step !== 'witch') {
    throw new GameError('NOT_YOUR_TURN', 'It is not the witch’s turn.');
  }
  const { player: witch, potions } = witchPrivate(state, action.actor);
  if (potions.poisonUsed) throw new GameError('POTION_USED', 'The poison potion is spent.');
  if (action.target === witch.seat) {
    throw new GameError('POTION_SELF_SAVE', 'The witch can never poison herself.');
  }
  requireLivingTarget(state, action.target);
  if (!state.config.witchDoublePotion && night.healUsedTonight) {
    throw new GameError('NOT_YOUR_TURN', 'Only one potion may be used tonight.');
  }
  potions.poisonUsed = true;
  night.poisonUsedTonight = true;
  night.poisonTarget = action.target;
  events.push({ type: 'WITCH_POISONED', actor: witch.seat, target: action.target });
}

export function handleWitchPass(
  state: GameState,
  action: Extract<GameAction, { type: 'WITCH_PASS' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.step !== 'witch') {
    throw new GameError('NOT_YOUR_TURN', 'It is not the witch’s turn.');
  }
  witchPrivate(state, action.actor);
  events.push({ type: 'WITCH_PASSED', actor: action.actor });
  advanceNightStep(state, events);
}

export function handleSeerCheck(
  state: GameState,
  action: Extract<GameAction, { type: 'SEER_CHECK' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.step !== 'seer') {
    throw new GameError('NOT_YOUR_TURN', 'It is not the seer’s turn.');
  }
  const seer = requireSeer(state, action.actor);
  if (action.target === seer.seat) {
    throw new GameError('INVALID_TARGET', 'The seer cannot check herself.');
  }
  const target = requireLivingTarget(state, action.target);
  const priv = seer.private;
  if (priv.kind !== 'seer') throw new GameError('NOT_YOUR_TURN', 'Seat is not the seer.');
  const result = campOf(target.role) === 'wolf' ? 'wolf' : 'good';
  priv.checks[action.target] = result;
  events.push({ type: 'SEER_CHECKED', actor: seer.seat, target: action.target, result });
  completeNight(state, events);
}

export function handleSeerPass(
  state: GameState,
  action: Extract<GameAction, { type: 'SEER_PASS' }>,
  events: GameEvent[],
): void {
  const night = requireNight(state);
  if (night.step !== 'seer') {
    throw new GameError('NOT_YOUR_TURN', 'It is not the seer’s turn.');
  }
  requireSeer(state, action.actor);
  events.push({ type: 'SEER_PASSED', actor: action.actor });
  completeNight(state, events);
}

function requireSeer(state: GameState, seat: Seat) {
  const p = getPlayer(state, seat);
  if (!p.alive) throw new GameError('PLAYER_DEAD', 'Dead players cannot act.');
  if (p.role !== 'seer') throw new GameError('NOT_YOUR_TURN', 'Only the seer checks camps.');
  return p;
}
