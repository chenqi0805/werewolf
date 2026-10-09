import type { EngineConfig } from './config';
import { DEFAULT_CONFIG } from './config';
import { GameError } from './errors';
import type { GameState } from './state';
import type { PlayerState, Role, Seat, SeatAssignment } from './types';
import { SEAT_COUNT } from './types';

const STANDARD_BOARD: Record<Role, number> = {
  werewolf: 4,
  villager: 4,
  seer: 1,
  witch: 1,
  hunter: 1,
  idiot: 1,
};

/**
 * Creates the initial state. Seat assignment comes from the room server's
 * shuffled deck; the engine only validates the resulting lineup against the
 * standard board and that every seat 1..12 is filled exactly once.
 */
export function createGame(
  assignments: SeatAssignment[],
  config: EngineConfig = DEFAULT_CONFIG,
): GameState {
  if (assignments.length !== SEAT_COUNT) {
    throw new GameError(
      'INVALID_LINEUP',
      `Expected ${SEAT_COUNT} seats, got ${assignments.length}.`,
    );
  }
  const players = {} as Record<Seat, PlayerState>;
  const roleCounts = new Map<Role, number>();
  for (const { seat, role } of assignments) {
    if (!Number.isInteger(seat) || seat < 1 || seat > SEAT_COUNT) {
      throw new GameError('INVALID_LINEUP', `Seat ${seat} is out of range 1..${SEAT_COUNT}.`);
    }
    if (players[seat]) throw new GameError('SEAT_TAKEN', `Seat ${seat} is taken.`);
    players[seat] = {
      seat,
      role,
      alive: true,
      revealedIdiot: false,
      hasBadge: false,
      private: privateFor(role),
    };
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  for (const [role, count] of Object.entries(STANDARD_BOARD) as Array<[Role, number]>) {
    if ((roleCounts.get(role) ?? 0) !== count) {
      throw new GameError(
        'INVALID_LINEUP',
        `Expected ${count} ${role}; got ${roleCounts.get(role) ?? 0}.`,
      );
    }
  }
  return {
    phase: 'lobby',
    dayNumber: 1,
    players,
    night: null,
    pendingDawn: null,
    election: null,
    dawn: null,
    resolution: null,
    lastWords: null,
    speech: null,
    pk: null,
    vote: null,
    winner: null,
    log: [],
    config,
  };
}

function privateFor(role: Role): PlayerState['private'] {
  switch (role) {
    case 'seer':
      return { kind: 'seer', checks: {} };
    case 'witch':
      return { kind: 'witch', healUsed: false, poisonUsed: false };
    case 'hunter':
      return { kind: 'hunter', shotUsed: false };
    default:
      return { kind: role };
  }
}
