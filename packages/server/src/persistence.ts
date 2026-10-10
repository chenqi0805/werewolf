import type {
  BoardId,
  EngineConfig,
  GameAction,
  GameState,
  Seat,
  SeatAssignment,
} from '@werewolf/engine';
import { applyAction, createGame } from '@werewolf/engine';
import type {
  ActionRowRaw,
  EventStore,
  RoomRowRaw,
  RoomStatus,
  SeatKind,
  TimerRowRaw,
} from './eventStore';
import type { ActionSource, Room, RoomHooks, RoomRegistry } from './room';
import { Room as RoomImpl, type SeatIdentity } from './room';

/**
 * The bridge between rooms and the EventStore — the write hooks a live room
 * calls, and the replay that brings a stored room back. The engine package
 * learns nothing of any of this: every restore is assignments + config +
 * action log → createGame → fold, so a corrupted row can only ever fail
 * loudly at replay, never silently bend the rules.
 */

/** Engine phase → stored room status. */
export function roomStatusOf(state: GameState): RoomStatus {
  if (state.phase === 'lobby') return 'lobby';
  if (state.phase === 'game-over') return 'finished';
  return 'running';
}

/** The dealt deck, recovered from the engine state — fixed at creation. */
export function roomAssignmentsOf(state: GameState): SeatAssignment[] {
  return Object.values(state.players)
    .map((p) => ({ seat: p.seat, role: p.role }))
    .sort((a, b) => a.seat - b.seat);
}

/**
 * The hook set that mirrors one room's mutations into the store. Every hook
 * is synchronous and runs immediately after the in-memory change, so the
 * action stream on disk is always a prefix-consistent record of what was
 * applied.
 */
export function storeHooksFor(store: EventStore): (code: string) => RoomHooks {
  return (code) => ({
    onRoomChanged: (room) =>
      store.upsertRoom({
        code: room.code,
        board: room.state.board,
        status: roomStatusOf(room.state),
        assignmentsJson: JSON.stringify(roomAssignmentsOf(room.state)),
        configJson: JSON.stringify(room.state.config),
      }),
    onAction: (room, action: GameAction, source: ActionSource) =>
      store.appendAction({
        code,
        action,
        source,
        status: roomStatusOf(room.state),
      }),
    onSeatsChanged: (room) =>
      store.replaceSeats(
        room.code,
        room.seatRows().map((s) => ({
          ...s,
          kind: room.isBotSeat(s.seat) ? ('bot' as SeatKind) : ('human' as SeatKind),
        })),
      ),
  });
}

export interface RestoreSummary {
  /** Codes returned to the live registry, in creation order. */
  restored: string[];
  /** Codes whose replay threw — quarantined on disk, never restored. */
  quarantined: string[];
}

function parseRoomRow(row: RoomRowRaw): {
  board: BoardId;
  assignments: SeatAssignment[];
  config: EngineConfig;
} {
  return {
    board: row.board as BoardId,
    assignments: JSON.parse(row.assignmentsJson) as SeatAssignment[],
    config: JSON.parse(row.configJson) as EngineConfig,
  };
}

/** Folds the recorded action stream back to the engine state. */
function replayRoom(row: RoomRowRaw, actions: ActionRowRaw[]): GameState {
  const { board, assignments, config } = parseRoomRow(row);
  let state = createGame(assignments, board, config);
  for (const { seq, actionJson } of actions) {
    try {
      const action = JSON.parse(actionJson) as GameAction;
      state = applyAction(state, action).state;
    } catch (error) {
      // Name the failing row — an operator hand-editing the DB deserves the seq.
      throw new Error(`recorded action seq ${seq} failed to replay: ${String(error)}`, {
        cause: error,
      });
    }
  }
  return state;
}

/**
 * Rebuilds every persisted room by replaying its action stream. A room whose
 * replay throws is quarantined (marked on disk, its code reserved) and the
 * boot continues — one bad row never keeps the server down. Running rooms
 * come back with their clock: `rearm` receives the persisted deadline so the
 * gateway can schedule the remaining time; a deadline already in the past
 * resolves on the next tick, exactly like an expiry that fired mid-downtime.
 * Quarantine is a replay-failure verdict only — a `rearm` throw is logged
 * and the live room stays served.
 */
export function restoreRooms(
  store: EventStore,
  registry: RoomRegistry,
  rearm?: (room: Room, timer: TimerRowRaw | null) => void,
): RestoreSummary {
  const summary: RestoreSummary = { restored: [], quarantined: [] };
  for (const row of store.loadRoomRows()) {
    try {
      const actions = store.loadActionRows(row.code);
      const seatRows = store.loadSeatRows(row.code);
      // Read before the room goes live: a failed clock read lands in the
      // catch below while the room is still unserved, never quarantining a
      // room that is already in the registry.
      const timer = store.loadTimerRow(row.code);
      const state = replayRoom(row, actions);
      const seats = new Map<Seat, SeatIdentity>(
        seatRows.map((s) => [s.seat, { tokenHash: s.tokenHash, name: s.name }]),
      );
      const bots = new Set(seatRows.filter((s) => s.kind === 'bot').map((s) => s.seat));
      const room = new RoomImpl({
        code: row.code,
        hooks: registry.hooksFor?.(row.code),
        restored: { state, seats, bots },
      });
      registry.restore(room);
      summary.restored.push(row.code);
      try {
        rearm?.(room, timer);
      } catch (error) {
        // A failed re-arm is not a replay failure: the room is live and its
        // state is consistent, so it stays served — only quarantining it
        // would poison a healthy row for the next boot.
        console.error(
          `[werewolf] room ${row.code}: timer re-arm failed — serving without a re-armed clock:`,
          error,
        );
      }
    } catch (error) {
      store.markQuarantined(row.code, Date.now());
      registry.reserveCode(row.code);
      console.error(`[werewolf] room ${row.code}: replay failed — quarantined:`, error);
      summary.quarantined.push(row.code);
    }
  }
  return summary;
}
