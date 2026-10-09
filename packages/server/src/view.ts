import type { Camp, GameEvent, GameState, Phase, Role, Seat } from '@werewolf/engine';
import { canVote, SEAT_COUNT, visibilityOf, voteWeight } from '@werewolf/engine';

/**
 * The fog-of-war projection — the security core of the product.
 *
 * A PlayerView is a server-side projection over GameState built for exactly
 * one seat (or a spectator). Raw state never leaves the process: roles appear
 * only when the viewer owns them, holds wolf knowledge, or the table has
 * revealed them (idiot flip, hunter shot, game-over). Votes, kill targets,
 * and other pending secrets never appear here at all.
 */

export interface PlayerRow {
  seat: Seat;
  alive: boolean;
  hasBadge: boolean;
  /** Public the moment the idiot flips — mirrors the IDIOT_REVEALED event. */
  revealedIdiot: boolean;
  /** Public: the table sees who votes, at what weight, and who cannot. */
  voteWeight: number;
  /** Non-null only when this viewer may see it (see viewFor). */
  role: Role | null;
}

export interface WitchPotionView {
  healUsed: boolean;
  poisonUsed: boolean;
  /** Present only while her night step is open — the heal/poison window. */
  maySelfSave?: boolean;
  killTarget?: Seat | null;
}

export interface YouView {
  /** null = spectator (joined a finished room). */
  seat: Seat | null;
  role: Role | null;
  alive: boolean;
  hasBadge: boolean;
  revealedIdiot: boolean;
  /** 0 (no rights), 1, or 1.5 with the badge — for the vote pad. */
  voteWeight: number;
  /** Wolf only, while alive: every wolf seat including self. */
  wolfPack?: Seat[];
  /** Seer only, while alive: accumulated check results, permanently. */
  seerChecks?: Partial<Record<Seat, Camp>>;
  /** Witch only, while alive. */
  witchPotions?: WitchPotionView;
  /** Hunter only, while alive. */
  hunterShotUsed?: boolean;
}

/** Public per-phase progress. Nothing here is secret at the table. */
export type StepView =
  | { kind: 'lobby' }
  | { kind: 'night'; step: 'wolf' | 'witch' | 'seer' }
  | { kind: 'sheriff-signup'; candidates: Seat[] }
  | { kind: 'sheriff-speech'; queue: Seat[]; cursor: number }
  | { kind: 'sheriff-vote'; electorate: Seat[] }
  | { kind: 'dawn-announce'; remaining: number }
  | { kind: 'last-words'; queue: Seat[]; cursor: number }
  | { kind: 'speech'; order: Seat[] | null; cursor: number }
  | { kind: 'exile-vote'; electorate: Seat[] }
  | { kind: 'pk-speech'; tied: Seat[]; cursor: number }
  | { kind: 'pk-vote'; electorate: Seat[]; voteKind: 'sheriff' | 'exile' }
  | { kind: 'hunter-shot'; seat: Seat | null }
  | { kind: 'badge-pass'; seat: Seat | null }
  | { kind: 'game-over' };

/**
 * Ambient pacing info for the phase clock currently running in the room.
 * Pure projection data — the server owns the clock; this only tells the
 * client when the present step expires so it can render a countdown.
 */
export interface TimerInfo {
  key: string;
  endsAt: number;
}

export interface PlayerView {
  phase: Phase;
  dayNumber: number;
  winner: 'wolves' | 'good' | null;
  you: YouView;
  players: PlayerRow[];
  step: StepView;
  /**
   * Every event this seat is entitled to, in order — full history, so a
   * rejoining client receives the backlog inside its first view.
   */
  log: GameEvent[];
  /** The step deadline the server is currently enforcing; null when none runs. */
  timer: TimerInfo | null;
}

/** Roles the table has learned from public events so far. */
function publiclyRevealed(state: GameState): Map<Seat, Role> {
  const revealed = new Map<Seat, Role>();
  for (const event of state.log) {
    if (event.type === 'IDIOT_REVEALED') revealed.set(event.seat, 'idiot');
    if (event.type === 'HUNTER_SHOT') revealed.set(event.shooter, 'hunter');
  }
  return revealed;
}

/** The events a seat (or spectator) may receive, in order. */
export function eventsForSeat(events: readonly GameEvent[], seat: Seat | null): GameEvent[] {
  return events.filter((event) => {
    const visibility = visibilityOf(event);
    if (visibility.kind === 'public') return true;
    if (visibility.kind === 'server') return false;
    return seat !== null && visibility.seats.includes(seat);
  });
}

function stepView(state: GameState): StepView {
  switch (state.phase) {
    case 'lobby':
      return { kind: 'lobby' };
    case 'night':
      return { kind: 'night', step: state.night?.step ?? 'wolf' };
    case 'sheriff-signup':
      return {
        kind: 'sheriff-signup',
        candidates: [...(state.election?.candidates ?? [])].sort((a, b) => a - b),
      };
    case 'sheriff-speech':
      return {
        kind: 'sheriff-speech',
        queue: [...(state.election?.speechQueue ?? [])],
        cursor: state.election?.speechCursor ?? 0,
      };
    case 'sheriff-vote':
      return { kind: 'sheriff-vote', electorate: [...(state.vote?.electorate ?? [])] };
    case 'dawn-announce':
      return { kind: 'dawn-announce', remaining: state.dawn?.pending.length ?? 0 };
    case 'last-words':
      return {
        kind: 'last-words',
        queue: [...(state.lastWords?.queue ?? [])],
        cursor: state.lastWords?.cursor ?? 0,
      };
    case 'speech':
      return {
        kind: 'speech',
        order: state.speech?.order ? [...state.speech.order] : null,
        cursor: state.speech?.cursor ?? 0,
      };
    case 'exile-vote':
      return { kind: 'exile-vote', electorate: [...(state.vote?.electorate ?? [])] };
    case 'pk-speech':
      return {
        kind: 'pk-speech',
        tied: [...(state.pk?.tied ?? [])],
        cursor: state.pk?.cursor ?? 0,
      };
    case 'pk-vote':
      // An open election means the PK belongs to the sheriff race; once the
      // election has resolved (or never happened), a PK vote is the exile's.
      return {
        kind: 'pk-vote',
        electorate: [...(state.vote?.electorate ?? [])],
        voteKind: state.election !== null ? 'sheriff' : 'exile',
      };
    case 'hunter-shot':
    case 'badge-pass': {
      const head = state.resolution?.queue[0];
      return { kind: state.phase, seat: head?.seat ?? null };
    }
    case 'game-over':
      return { kind: 'game-over' };
  }
}

/**
 * Builds the view for one seat. `seat === null` yields the spectator view:
 * public information only. Dead players keep their own identity but drop
 * role-specific extras — the dead watch like spectators until game-over.
 */
export function viewFor(
  state: GameState,
  seat: Seat | null,
  timer: TimerInfo | null = null,
): PlayerView {
  const over = state.phase === 'game-over';
  const viewer = seat === null ? null : (state.players[seat] ?? null);
  const revealed = publiclyRevealed(state);
  const wolves = new Set(
    Object.values(state.players)
      .filter((p) => p.role === 'werewolf')
      .map((p) => p.seat),
  );
  // Extras (wolf pack, seer checks, potion state) belong to living, seated
  // viewers of a started game only; at game-over the full reveal covers
  // everything anyway. The lobby reveals nothing — cards are dealt at start.
  const started = state.phase !== 'lobby';
  const extras = started && viewer !== null && viewer.alive;
  const seesWolfPack = extras && viewer.role === 'werewolf';

  const players: PlayerRow[] = [];
  for (let s = 1; s <= SEAT_COUNT; s++) {
    const p = state.players[s];
    if (!p) continue;
    let role: Role | null = started ? (revealed.get(p.seat) ?? null) : null;
    if (started && over) role = p.role;
    else if (started && viewer !== null && viewer.seat === p.seat) role = p.role;
    else if (started && seesWolfPack && wolves.has(p.seat)) role = 'werewolf';
    players.push({
      seat: p.seat,
      alive: p.alive,
      hasBadge: p.hasBadge,
      revealedIdiot: p.revealedIdiot,
      voteWeight: started && canVote(p) ? voteWeight(p) : 0,
      role,
    });
  }

  let you: YouView;
  if (viewer === null) {
    you = {
      seat: null,
      role: null,
      alive: false,
      hasBadge: false,
      revealedIdiot: false,
      voteWeight: 0,
    };
  } else {
    you = {
      seat: viewer.seat,
      role: started ? viewer.role : null,
      alive: viewer.alive,
      hasBadge: viewer.hasBadge,
      revealedIdiot: viewer.revealedIdiot,
      voteWeight: started && canVote(viewer) ? voteWeight(viewer) : 0,
    };
    if (seesWolfPack) you.wolfPack = [...wolves].sort((a, b) => a - b);
    if (extras && viewer.private.kind === 'seer') {
      you.seerChecks = { ...viewer.private.checks };
    }
    if (extras && viewer.private.kind === 'witch') {
      const witchStepOpen = state.phase === 'night' && state.night?.step === 'witch';
      you.witchPotions = {
        healUsed: viewer.private.healUsed,
        poisonUsed: viewer.private.poisonUsed,
        ...(witchStepOpen
          ? {
              maySelfSave: state.night?.maySelfSave ?? false,
              killTarget: state.night?.killTarget ?? null,
            }
          : {}),
      };
    }
    if (extras && viewer.private.kind === 'hunter') {
      you.hunterShotUsed = viewer.private.shotUsed;
    }
  }

  return {
    phase: state.phase,
    dayNumber: state.dayNumber,
    winner: state.winner,
    you,
    players,
    step: stepView(state),
    log: eventsForSeat(state.log, seat),
    timer,
  };
}
