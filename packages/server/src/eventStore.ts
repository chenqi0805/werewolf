import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { GameAction } from '@werewolf/engine';

/**
 * The persistence layer — SQLite in WAL mode, one file, zero ops.
 *
 * The record is the action stream, not snapshots: the engine's own contract
 * (folding the same action sequence from `createGame` reproduces identical
 * states and events) means persisting assignments + frozen config + ordered
 * actions is sufficient, and events derive by replay — never stored.
 *
 * Rows are read and written as raw primitives (JSON columns stay strings):
 * parsing happens in the restore path inside a per-room try, so one
 * hand-corrupted row can only ever quarantine its own room, never fail the
 * boot. Every write is synchronous — WAL keeps an append sub-millisecond,
 * and committed frames survive a process kill (SIGKILL included).
 */

/** Lifecycle of a room row, derived from the engine phase at write time. */
export type RoomStatus = 'lobby' | 'running' | 'finished';

/** Seats are always humans today; the column exists for the v2 bot seats. */
export type SeatKind = 'human' | 'bot';

/** Raw `rooms` row — JSON columns unparsed. */
export interface RoomRowRaw {
  code: string;
  board: string;
  status: string;
  assignmentsJson: string;
  configJson: string;
  quarantinedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Raw `room_actions` row — action JSON unparsed. */
export interface ActionRowRaw {
  seq: number;
  actionJson: string;
  source: string;
}

/** Raw `room_seats` row. */
export interface SeatRowRaw {
  seat: number;
  tokenHash: string;
  kind: string;
}

/** Raw `room_timers` row — the re-arm data for one running clock. */
export interface TimerRowRaw {
  timerKey: string;
  endsAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code            TEXT PRIMARY KEY,
  board           TEXT NOT NULL,
  status          TEXT NOT NULL,
  assignments     TEXT NOT NULL,
  config          TEXT NOT NULL,
  quarantined_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_actions (
  code   TEXT NOT NULL REFERENCES rooms(code),
  seq    INTEGER NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (code, seq)
);
CREATE TABLE IF NOT EXISTS room_seats (
  code       TEXT NOT NULL REFERENCES rooms(code),
  seat       INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  kind       TEXT NOT NULL,
  PRIMARY KEY (code, seat)
);
CREATE TABLE IF NOT EXISTS room_timers (
  code      TEXT PRIMARY KEY REFERENCES rooms(code),
  timer_key TEXT NOT NULL,
  ends_at   INTEGER NOT NULL
);
`;

export class EventStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    // The default deployment path (data/ under the hosted workdir) may not
    // exist yet; SQLite fails on a missing directory, so create it first.
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL + NORMAL is the standard durable-for-process-crash pairing: every
    // committed frame is visible to the next connection and survives SIGKILL;
    // only an OS-level crash may drop the last commits (no fsync per commit).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** Inserts or refreshes the room row (create, and restore re-attach). */
  upsertRoom(row: {
    code: string;
    board: string;
    status: string;
    assignmentsJson: string;
    configJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO rooms (code, board, status, assignments, config, created_at, updated_at)
         VALUES (@code, @board, @status, @assignmentsJson, @configJson, @now, @now)
         ON CONFLICT(code) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run({ ...row, now: Date.now() });
  }

  /**
   * Appends one applied action and touches the room row — the entire hot-path
   * cost of persistence. `seq` is assigned inside the statement so appends
   * stay strictly ordered per room even across callers.
   */
  appendAction(row: { code: string; action: GameAction; source: string; status: string }): void {
    const actionJson = JSON.stringify(row.action);
    const touch = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO room_actions (code, seq, action, source)
           VALUES (@code, (SELECT COALESCE(MAX(seq), 0) + 1 FROM room_actions WHERE code = @code),
                   @actionJson, @source)`,
        )
        .run({ code: row.code, actionJson, source: row.source });
      this.db
        .prepare(`UPDATE rooms SET status = @status, updated_at = @now WHERE code = @code`)
        .run({ code: row.code, status: row.status, now: Date.now() });
    });
    touch();
  }

  /** Rewrites the room's seat rows — join is the only seat mutation. */
  replaceSeats(
    code: string,
    seats: ReadonlyArray<{ seat: number; tokenHash: string; kind: SeatKind }>,
  ): void {
    const write = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM room_seats WHERE code = ?`).run(code);
      for (const { seat, tokenHash, kind } of seats) {
        this.db
          .prepare(`INSERT INTO room_seats (code, seat, token_hash, kind) VALUES (?, ?, ?, ?)`)
          .run(code, seat, tokenHash, kind);
      }
    });
    write();
  }

  /** armTimer's upsert: the re-arm data for the room's running clock. */
  upsertTimer(code: string, timerKey: string, endsAt: number): void {
    this.db
      .prepare(
        `INSERT INTO room_timers (code, timer_key, ends_at) VALUES (?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET timer_key = excluded.timer_key, ends_at = excluded.ends_at`,
      )
      .run(code, timerKey, endsAt);
  }

  /** The room's clock stopped (no clock key, or game over). */
  clearTimer(code: string): void {
    this.db.prepare(`DELETE FROM room_timers WHERE code = ?`).run(code);
  }

  /**
   * Marks a room whose replay threw. Quarantined rooms are skipped by every
   * later boot — the corrupt row stays on disk for inspection instead of
   * failing the server forever.
   */
  markQuarantined(code: string, at: number): void {
    this.db.prepare(`UPDATE rooms SET quarantined_at = ? WHERE code = ?`).run(at, code);
  }

  /** Every playable room row, oldest first. Quarantined rows excluded. */
  loadRoomRows(): RoomRowRaw[] {
    return (
      this.db
        .prepare(
          `SELECT code, board, status, assignments, config, quarantined_at, created_at, updated_at
           FROM rooms WHERE quarantined_at IS NULL ORDER BY created_at, code`,
        )
        .all()
        // The row object carries the column names verbatim.
        .map((row) => row as Record<string, unknown>)
        .map((row) => ({
          code: row.code as string,
          board: row.board as string,
          status: row.status as string,
          assignmentsJson: row.assignments as string,
          configJson: row.config as string,
          quarantinedAt: (row.quarantined_at as number | null) ?? null,
          createdAt: row.created_at as number,
          updatedAt: row.updated_at as number,
        }))
    );
  }

  /** The room's recorded actions, in applied order. */
  loadActionRows(code: string): ActionRowRaw[] {
    return this.db
      .prepare(`SELECT seq, action, source FROM room_actions WHERE code = ? ORDER BY seq`)
      .all(code)
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        seq: row.seq as number,
        actionJson: row.action as string,
        source: row.source as string,
      }));
  }

  /** The room's seated tokens (hashed), lowest seat first. */
  loadSeatRows(code: string): SeatRowRaw[] {
    return this.db
      .prepare(`SELECT seat, token_hash, kind FROM room_seats WHERE code = ? ORDER BY seat`)
      .all(code)
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        seat: row.seat as number,
        tokenHash: row.token_hash as string,
        kind: row.kind as string,
      }));
  }

  /** The room's persisted clock, or null when none was armed. */
  loadTimerRow(code: string): TimerRowRaw | null {
    const row = this.db
      .prepare(`SELECT timer_key, ends_at FROM room_timers WHERE code = ?`)
      .get(code) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { timerKey: row.timer_key as string, endsAt: row.ends_at as number };
  }

  close(): void {
    this.db.close();
  }
}
