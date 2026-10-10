import { campOf } from '@werewolf/engine';
import type { PlayerAction } from '@werewolf/engine';
import type { PlayerView, StepView, TimerInfo } from '@werewolf/server';

import type { Role, SeatView, SpeechRecord } from '../types';
import {
  livingOthersOf,
  seatViewsOf,
  speechByDayOf,
  uncheckedTargetsOf,
  wolfTargetsOf,
} from '../client/adapters';

/**
 * Pure decision helpers for the screens: given the current PlayerView, what may
 * this seat do right now, and with which action shape? The JSX stays thin —
 * every gate here is unit-tested.
 */

export type NightPadKind = 'wolf' | 'witch' | 'seer' | 'guard' | 'waiting';

export interface VoteContext {
  actionKind: 'SHERIFF_VOTE' | 'EXILE_VOTE';
  electorate: SeatView[];
}

export interface SheriffSignupState {
  signedUp: boolean;
  canSignup: boolean;
  canWithdraw: boolean;
  candidates: SeatView[];
}

export interface HunterShotState {
  active: boolean;
  targets: SeatView[];
}

function stepOf(view: PlayerView): StepView {
  return view.step;
}

function seatViewsBySeat(view: PlayerView): Map<number, SeatView> {
  return new Map(seatViewsOf(view).map((r) => [r.seat, r]));
}

function electorateViews(view: PlayerView, electorate: readonly number[]): SeatView[] {
  const bySeat = seatViewsBySeat(view);
  const out: SeatView[] = [];
  for (const seat of electorate) {
    const found = bySeat.get(seat);
    if (found) out.push(found);
  }
  return out;
}

/** Which night pad, if any, this seat is entitled to right now. */
export function nightPadKind(view: PlayerView): NightPadKind {
  const step = stepOf(view);
  if (step.kind !== 'night' || view.you.seat === null || !view.you.alive) return 'waiting';
  const { role } = view.you;
  // The wolfking board's guard wakes before the pack: while his window is
  // pending the wire step still reads 'wolf', and only the guard may act.
  if (step.guardPending === true) return role === 'guard' ? 'guard' : 'waiting';
  // Camp, not the literal — the 白狼王 votes in the nightly kill like any
  // wolf, and without a pad his timer default would force 空刀 every night.
  if (step.step === 'wolf' && role !== null && campOf(role) === 'wolf') return 'wolf';
  if (step.step === 'witch' && role === 'witch') return 'witch';
  if (step.step === 'seer' && role === 'seer') return 'seer';
  return 'waiting';
}

/** The guard's night options, or null when this seat holds no guard window. */
export function guardOptionsOf(view: PlayerView): GuardOptions | null {
  return nightPadKind(view) === 'guard' ? (view.you.guardOptions ?? null) : null;
}

/** Living others offered to the guard's protection (自守 rides its own toggle). */
export function guardTargets(view: PlayerView): SeatView[] {
  return livingOthersOf(view);
}

/** Living non-wolf seats offered to the pack's kill vote. */
export function nightTargets(view: PlayerView): SeatView[] {
  return wolfTargetsOf(view);
}

/** Living others offered to the witch's poison. */
export function poisonTargets(view: PlayerView): SeatView[] {
  return livingOthersOf(view);
}

/** Living, not-yet-checked seats offered to the seer. */
export function seerTargets(view: PlayerView): SeatView[] {
  return uncheckedTargetsOf(view);
}

/** The ballot this step asks for, or null outside vote steps. */
export function voteContextOf(view: PlayerView): VoteContext | null {
  const step = stepOf(view);
  if (step.kind === 'sheriff-vote')
    return { actionKind: 'SHERIFF_VOTE', electorate: electorateViews(view, step.electorate) };
  if (step.kind === 'exile-vote')
    return { actionKind: 'EXILE_VOTE', electorate: electorateViews(view, step.electorate) };
  if (step.kind === 'pk-vote') {
    return {
      actionKind: step.voteKind === 'sheriff' ? 'SHERIFF_VOTE' : 'EXILE_VOTE',
      electorate: electorateViews(view, step.electorate),
    };
  }
  return null;
}

/** May the viewer cast the current ballot? Dead seats, non-electorate, and the revealed idiot (no rights) may not. */
export function canVoteNow(view: PlayerView): boolean {
  const { seat, alive, voteWeight } = view.you;
  if (seat === null || !alive || voteWeight <= 0) return false;
  const context = voteContextOf(view);
  if (!context) return false;
  return context.electorate.some((r) => r.seat === seat);
}

/** May the viewer post to the current speech slot? */
export function canSpeakNow(view: PlayerView): boolean {
  const { seat, alive } = view.you;
  if (seat === null || !alive) return false;
  const step = stepOf(view);
  const speaker =
    (step.kind === 'speech' && step.order ? (step.order[step.cursor] ?? null) : null) ??
    (step.kind === 'last-words' ? (step.queue[step.cursor] ?? null) : null) ??
    (step.kind === 'sheriff-speech' ? (step.queue[step.cursor] ?? null) : null) ??
    (step.kind === 'pk-speech' ? (step.tied[step.cursor] ?? null) : null);
  return speaker === seat;
}

/** Caption key for the active speech panel, or null outside speech slots. */
export function speechContextOf(
  view: PlayerView,
): 'sheriff-speech' | 'last-words' | 'speech' | 'pk-speech' | null {
  const step = stepOf(view);
  if (
    step.kind === 'sheriff-speech' ||
    step.kind === 'last-words' ||
    step.kind === 'speech' ||
    step.kind === 'pk-speech'
  ) {
    return step.kind;
  }
  return null;
}

/** Everything the strategy assistant needs, resolved once the gate passes. */
export interface StrategyContext {
  /** The viewer's own role — the advisor's frame of reference. */
  role: Role;
  /** Day-grouped public speech record, days ascending. */
  dayRecords: Array<{ day: number; records: SpeechRecord[] }>;
}

/**
 * The strategy assistant is offered only to the seat holding the mic, while
 * alive, with at least one speech on the public record to reason from — the
 * server enforces the same three conditions before answering.
 */
export function strategyContextOf(view: PlayerView): StrategyContext | null {
  if (!canSpeakNow(view)) return null;
  const { role } = view.you;
  if (role === null) return null;
  const dayRecords = speechByDayOf(view);
  if (dayRecords.length === 0) return null;
  return { role, dayRecords };
}

/** Signup-pad state during the sheriff election. */
export function sheriffSignupState(view: PlayerView): SheriffSignupState {
  const step = stepOf(view);
  const candidates = step.kind === 'sheriff-signup' ? electorateViews(view, step.candidates) : [];
  const { seat, alive } = view.you;
  const signedUp = seat !== null && candidates.some((r) => r.seat === seat);
  return {
    signedUp,
    canSignup: step.kind === 'sheriff-signup' && seat !== null && alive && !signedUp,
    canWithdraw: step.kind === 'sheriff-signup' && signedUp,
    candidates,
  };
}

/** The guard's night options as projected onto his view. */
export interface GuardOptions {
  maySelfProtect: boolean;
  mayPass: boolean;
  repeatBan: boolean;
  lastProtected: number | null;
}

/** The 白狼王's self-destruct window state. */
export interface DestructState {
  active: boolean;
  targets: SeatView[];
}

/**
 * The 白狼王 self-destructs during the day's speech rounds (living) or at his
 * own exile settlement — the same interrupt phase a dying hunter's shot gets.
 * Used up, wrong seat, or wrong phase: never active.
 */
export function destructState(view: PlayerView): DestructState {
  const step = stepOf(view);
  const { seat, alive, role, destructUsed } = view.you;
  if (seat === null || role !== 'white_wolf_king' || destructUsed) {
    return { active: false, targets: [] };
  }
  const settlement = step.kind === 'hunter-shot' && step.seat === seat;
  const speaking = (step.kind === 'speech' || step.kind === 'pk-speech') && alive;
  if (!settlement && !speaking) return { active: false, targets: [] };
  return { active: true, targets: livingOthersOf(view) };
}

/** Is the viewer's hunter shot window open, and who can be hit? */
export function hunterShotState(view: PlayerView): HunterShotState {
  const step = stepOf(view);
  const armed =
    step.kind === 'hunter-shot' &&
    view.you.seat !== null &&
    step.seat === view.you.seat &&
    view.you.role === 'hunter' &&
    !view.you.hunterShotUsed;
  return { active: armed, targets: armed ? livingOthersOf(view) : [] };
}

/** The sheriff must set the day's speech direction before speeches begin. */
export function directionNeeded(view: PlayerView): boolean {
  const step = stepOf(view);
  return (
    step.kind === 'speech' && step.order === null && view.you.hasBadge && view.you.seat !== null
  );
}

/** Countdown: milliseconds left, clamped at zero; null when no timer. */
export function msLeftOf(timer: TimerInfo | null, now: number): number | null {
  if (!timer) return null;
  return Math.max(0, timer.endsAt - now);
}

/** Countdown: `m:ss`; negative leftovers clamp to `0:00`. */
export function formatCountdown(msLeft: number): string {
  const clamped = Math.max(0, msLeft);
  const seconds = Math.floor(clamped / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Poll helper for the countdown hook (kept out of tested logic). */
export const COUNTDOWN_TICK_MS = 250;

/** Build the action payload a pad submit should send, or null when invalid. */
export function actionFor(
  view: PlayerView,
  kind: 'kill' | 'protect' | 'heal' | 'poison' | 'check' | 'shoot' | 'destruct',
  target: number | null,
): PlayerAction | null {
  const seat = view.you.seat;
  if (seat === null || target === null) return null;
  switch (kind) {
    case 'protect':
      return { type: 'GUARD_PROTECT', actor: seat, target };
    case 'destruct':
      return { type: 'WOLF_KING_DESTRUCT', actor: seat, target };
    case 'kill':
      return { type: 'WOLF_KILL', actor: seat, target };
    case 'heal':
      return { type: 'WITCH_HEAL', actor: seat };
    case 'poison':
      return { type: 'WITCH_POISON', actor: seat, target };
    case 'check':
      return { type: 'SEER_CHECK', actor: seat, target };
    case 'shoot':
      return { type: 'HUNTER_SHOOT', actor: seat, target };
  }
}

/**
 * Identity of the current speech slot, from this viewer's vantage: the
 * speech context plus the phase clock. The server re-arms its single clock
 * after every accepted change, so a new slot always moves `timer.endsAt`,
 * and nothing re-arms it mid-slot. Null when no speech context is open; a
 * log-length fallback keys the rare unclocked slot.
 */
export function speechSlotKeyOf(view: PlayerView): string | null {
  const context = speechContextOf(view);
  if (context === null) return null;
  const timer = view.timer;
  return timer !== null
    ? `${context}:${timer.key}:${timer.endsAt}`
    : `${context}:log:${view.log.length}`;
}
