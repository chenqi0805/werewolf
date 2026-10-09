import type { Seat } from '@werewolf/engine';
import {
  BotRunner,
  ScriptedStrategy,
  mulberry32,
  seedFromString,
  type BotStrategy,
} from '@werewolf/bots';
import type { Room } from './room';

/**
 * Server-side custody of bot seats. The Room records that a seat belongs to
 * an AI player; the manager owns the loopback runner that plays it — spawned
 * on `addBot`, respawned after a restore, retired on removal or room end.
 * Runners are ordinary socket clients: the gateway checks their actions
 * exactly like a browser's, so nothing here can bypass the rules.
 */
export class BotManager {
  /** code → seat → live runner (running or already stopped). */
  private readonly runners = new Map<string, Map<Seat, BotRunner>>();

  constructor(
    /**
     * Loopback URL of this server's own listener. A callable so a runner
     * scheduled before the server binds (boot respawn on a port-0 test
     * server) resolves the address lazily; the runner's retry loop re-asks.
     */
    private readonly url: () => string,
    /**
     * Brain factory — one fresh strategy per runner (strategies can hold
     * per-game memory like the guard's last protection). Defaults to the
     * scripted brain: CI and e2e run with no model and no network. The
     * production entry hands an LLM-with-scripted-fallback factory here.
     */
    private readonly strategyFactory: () => BotStrategy = () => new ScriptedStrategy(),
  ) {}

  /**
   * Ensures every bot seat of the room has a live runner. Idempotent —
   * seats already carrying a runner are skipped — so it is safe to call
   * after every add and after every boot-time restore. Restored bot seats
   * have hash-only tokens, so each spawn remints the seat's token (bots
   * only; human sessions are never invalidated).
   */
  spawnFor(room: Room): void {
    if (room.isFinished()) return;
    let bySeat = this.runners.get(room.code);
    if (!bySeat) {
      bySeat = new Map();
      this.runners.set(room.code, bySeat);
    }
    for (const [seat, name] of room.botSeats()) {
      if (bySeat.has(seat)) continue;
      const token = room.remintBotToken(seat);
      const runner = new BotRunner({
        url: this.url,
        roomCode: room.code,
        token,
        strategy: this.strategyFactory(),
        // Seeded from code + seat, not the (reminted) token, so a restored
        // bot resumes the same deterministic stream it played before.
        rng: mulberry32(seedFromString(`${room.code}#${seat}`)),
        onEnd: (reason) => {
          console.log(`[werewolf] bot ${name} (${room.code}#${seat}) stopped: ${reason}`);
        },
      });
      runner.start();
      bySeat.set(seat, runner);
    }
  }

  /**
   * Seats one AI player (lobby-only, lowest free seat, pool nickname) and
   * spawns its runner. If the runner could not be created, the seat is
   * rolled back — a seated bot with no runner would stall the wolf pack.
   */
  addBot(room: Room): { seat: Seat; name: string } {
    const { seat, name } = room.addBot();
    try {
      this.spawnFor(room);
    } catch (error) {
      room.removeBot(seat);
      throw error;
    }
    return { seat, name };
  }

  /** Retires one bot's runner and frees its seat (lobby-only). */
  removeBot(room: Room, seat: Seat): void {
    room.removeBot(seat);
    this.stopRunner(room.code, seat);
  }

  /** Stops every runner for a room — game over, or the room is gone. */
  retireRoom(code: string): void {
    const bySeat = this.runners.get(code);
    if (!bySeat) return;
    for (const seat of [...bySeat.keys()]) {
      this.stopRunner(code, seat);
    }
    this.runners.delete(code);
  }

  /** Stops every runner in every room — app shutdown. */
  retireAll(): void {
    for (const code of [...this.runners.keys()]) {
      this.retireRoom(code);
    }
  }

  /** Live-runner count for a room (all rooms when omitted) — test observability. */
  runnerCount(code?: string): number {
    if (code !== undefined) return this.runners.get(code)?.size ?? 0;
    let total = 0;
    for (const bySeat of this.runners.values()) total += bySeat.size;
    return total;
  }

  private stopRunner(code: string, seat: Seat): void {
    const runner = this.runners.get(code)?.get(seat);
    if (!runner) return;
    runner.stop();
    this.runners.get(code)?.delete(seat);
  }
}
