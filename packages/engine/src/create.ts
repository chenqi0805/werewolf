import type { EngineConfig } from './config';
import { BOARDS, type BoardId } from './boards';
import { GameError } from './errors';
import type { GameState } from './state';
import type { PlayerState, Role, Seat, SeatAssignment } from './types';
import { SEAT_COUNT } from './types';

/**
 * Creates the initial state for the classic board with full config (the v1
 * call shape the server and the existing suites use).
 */
export function createGame(assignments: SeatAssignment[], config?: EngineConfig): GameState;
/** Creates the initial state for a named board, merged with per-knob overrides. */
export function createGame(
  assignments: SeatAssignment[],
  board: BoardId,
  config?: EngineConfig,
): GameState;
export function createGame(
  assignments: SeatAssignment[],
  boardOrConfig: BoardId | EngineConfig = 'classic',
  config?: EngineConfig,
): GameState {
  const boardId: BoardId = typeof boardOrConfig === 'string' ? boardOrConfig : 'classic';
  const overrides: EngineConfig | undefined =
    typeof boardOrConfig === 'string' ? config : boardOrConfig;
  const board = BOARDS[boardId];
  // A full config argument behaves exactly like v1 (it replaces the board
  // defaults field by field); partial overrides merge over them.
  const effectiveConfig = { ...board.config, ...overrides };

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
  for (const [role, count] of Object.entries(board.deck) as Array<[Role, number]>) {
    if ((roleCounts.get(role) ?? 0) !== count) {
      throw new GameError(
        'INVALID_LINEUP',
        `Expected ${count} ${role}; got ${roleCounts.get(role) ?? 0}.`,
      );
    }
  }
  // The counts above fix the totals (a board's deck sums to SEAT_COUNT), so
  // this only fires for a mis-dealt deck handing out a foreign role.
  for (const role of roleCounts.keys()) {
    if ((board.deck[role] ?? 0) === 0) {
      throw new GameError('INVALID_LINEUP', `${role} is not on the ${board.name} board.`);
    }
  }
  return {
    board: boardId,
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
    config: effectiveConfig,
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
    case 'white_wolf_king':
      return { kind: 'white_wolf_king', destructUsed: false };
    default:
      return { kind: role };
  }
}
