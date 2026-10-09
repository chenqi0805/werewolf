import type { GameEvent } from './events';
import { GameError } from './errors';
import type { DeathCause, DeathRecord, GameState, NightState, ResolutionState } from './state';
import { freshNight, getPlayer, livingPlayers, requireNight } from './state';
import type { Seat } from './types';
import { GOD_ROLES } from './types';

/**
 * 屠边 win check. Wolves win when every villager is dead OR all four gods are
 * dead; good wins when every wolf is dead. If both sides are somehow wiped in
 * the same step, "all wolves dead" is checked first (good wins).
 *
 * Called exactly once per death-application batch — never mid-action.
 */
export function winCheck(state: GameState): 'wolves' | 'good' | null {
  const ps = Object.values(state.players);
  if (ps.every((p) => p.role !== 'werewolf' || !p.alive)) return 'good';
  const villagersAllDead = ps.filter((p) => p.role === 'villager').every((p) => !p.alive);
  const godsAllDead = ps.filter((p) => GOD_ROLES.includes(p.role)).every((p) => !p.alive);
  return villagersAllDead || godsAllDead ? 'wolves' : null;
}

export function gameOver(state: GameState, winner: 'wolves' | 'good', events: GameEvent[]): void {
  state.winner = winner;
  state.phase = 'game-over';
  events.push({ type: 'GAME_OVER', winner });
}

/** Re-checks the win condition; returns true once the game is over. */
export function checkGameOver(state: GameState, events: GameEvent[]): boolean {
  if (state.winner) return true;
  const w = winCheck(state);
  if (!w) return false;
  gameOver(state, w, events);
  return true;
}

/**
 * Applies a death and builds its interrupt record. Deaths are applied
 * immediately; their *announcements* follow the dawn/election ordering.
 */
export function applyDeath(
  state: GameState,
  seat: Seat,
  cause: DeathCause,
  events: GameEvent[],
): DeathRecord {
  const p = getPlayer(state, seat);
  if (!p.alive) throw new GameError('PLAYER_DEAD', `Seat ${seat} is already dead.`);
  p.alive = false;
  const shotUsed = p.private.kind === 'hunter' ? p.private.shotUsed : false;
  const record: DeathRecord = {
    seat,
    cause,
    hunterWindow:
      p.role === 'hunter' &&
      !shotUsed &&
      (cause !== 'poison' || !state.config.poisonSilencesHunter),
    hunterWindowDone: false,
    badgePass: p.hasBadge,
    badgeDone: false,
    lastWordsEligible:
      state.config.nightDeathLastWords === 'night1-only' &&
      state.dayNumber === 1 &&
      (cause === 'wolf-kill' || cause === 'poison'),
    announced: false,
  };
  events.push({ type: 'DEATH_RESOLVED', seat, cause });
  return record;
}

/**
 * Drains the interrupt queue: badge pass first, then the hunter shot window,
 * each waiting on the dead player's action. Any action that resolves a death
 * calls back into this; when the queue empties the step finishes with the win
 * check and the phase advance. Once the win condition holds, remaining
 * interrupts are short-circuited — a dead sheriff is never asked to pass a
 * badge in a finished game.
 */
export function drainResolution(state: GameState, events: GameEvent[]): void {
  const res = state.resolution;
  if (!res) throw new GameError('WRONG_PHASE', 'No death resolution is in progress.');
  while (res.queue.length > 0) {
    if (res.newDeaths && checkGameOver(state, events)) {
      state.resolution = null;
      return;
    }
    const head = res.queue[0];
    if (!head) break;
    if (head.badgePass && !head.badgeDone) {
      state.phase = 'badge-pass';
      return;
    }
    if (head.hunterWindow && !head.hunterWindowDone) {
      state.phase = 'hunter-shot';
      return;
    }
    res.queue.shift();
  }
  finishResolutionStep(state, res, events);
}

function finishResolutionStep(state: GameState, res: ResolutionState, events: GameEvent[]): void {
  state.resolution = null;
  if (res.newDeaths && checkGameOver(state, events)) return;
  if (res.origin === 'dawn') afterDawn(state);
  else enterNight(state, events);
}

/** Night deaths: the win check fires here, before any election or dawn. */
export function completeNight(state: GameState, events: GameEvent[]): void {
  const night = requireNight(state);
  const deaths = computeNightDeaths(night);
  state.night = null;
  state.pendingDawn = deaths.map((d) => applyDeath(state, d.seat, d.cause, events));
  if (checkGameOver(state, events)) return;
  if (state.dayNumber === 1) {
    state.election = {
      candidates: [],
      speechQueue: [],
      speechCursor: 0,
      electorate: [],
      votes: {},
    };
    state.phase = 'sheriff-signup';
  } else {
    enterDawn(state, events);
  }
}

/**
 * Wolf kill vs heal vs poison. Poison overrides heal on the same target;
 * causes matter downstream for hunter eligibility. Empty by design on 平安夜.
 */
function computeNightDeaths(night: NightState): Array<{ seat: Seat; cause: DeathCause }> {
  const deaths: Array<{ seat: Seat; cause: DeathCause }> = [];
  const { killTarget, poisonTarget, healed } = night;
  if (killTarget !== null) {
    const poisoned = poisonTarget === killTarget;
    if (!healed || poisoned) {
      deaths.push({ seat: killTarget, cause: poisoned ? 'poison' : 'wolf-kill' });
    }
  }
  if (poisonTarget !== null && poisonTarget !== killTarget) {
    deaths.push({ seat: poisonTarget, cause: 'poison' });
  }
  return deaths.sort((a, b) => a.seat - b.seat);
}

/**
 * Enters dawn: consumes pending night deaths, or announces a 平安夜.
 */
export function enterDawn(state: GameState, events: GameEvent[]): void {
  const records = state.pendingDawn ?? [];
  state.pendingDawn = null;
  state.election = null;
  events.push({ type: 'DAY_BROKE', dayNumber: state.dayNumber });
  state.dawn = { pending: records.length > 0 ? records : ['peace'], announced: [] };
  state.phase = 'dawn-announce';
}

/**
 * After the dawn announcements (and any interrupts they opened): night-1
 * deaths give last words on day 1; from day 2 the speech round starts.
 */
export function afterDawn(state: GameState): void {
  const dawn = state.dawn;
  state.dawn = null;
  const lwSeats = dawn
    ? dawn.announced
        .filter((r) => r.lastWordsEligible)
        .map((r) => r.seat)
        .sort((a, b) => a - b)
    : [];
  if (lwSeats.length > 0) {
    state.lastWords = { queue: lwSeats, cursor: 0 };
    state.phase = 'last-words';
  } else {
    enterSpeech(state);
  }
}

/** Speech round entry: with a badge, direction is pending; otherwise ascending. */
export function enterSpeech(state: GameState): void {
  const living = livingPlayers(state);
  const sheriff = living.find((p) => p.hasBadge);
  state.speech = sheriff
    ? { order: null, cursor: 0 }
    : { order: living.map((p) => p.seat), cursor: 0 };
  state.phase = 'speech';
}

/** Advances to the next night; the win check has already passed by here. */
export function enterNight(state: GameState, events: GameEvent[]): void {
  state.dayNumber += 1;
  state.phase = 'night';
  state.night = freshNight(state);
  state.speech = null;
  state.vote = null;
  state.pk = null;
  state.lastWords = null;
  events.push({ type: 'NIGHT_BEGAN', dayNumber: state.dayNumber });
}
