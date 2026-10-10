import type { BotRunnerOptions } from '@werewolf/bots';
import { describe, expect, it, vi } from 'vitest';

import { BotManager } from '../bots';
import { Room } from '../room';
import { STANDARD } from './fixtures';

/**
 * BotManager unit behavior: the runner-map invariant ("map entry = live
 * runner") that spawnFor's skip-guard leans on. The wire-level lifecycle is
 * covered by the integration suite; here the runner is a stand-in so a
 * connect-failed end costs no retry budget.
 */

const constructors: BotRunnerOptions[] = [];

vi.mock('@werewolf/bots', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  class FakeBotRunner {
    constructor(opts: BotRunnerOptions) {
      constructors.push(opts);
    }

    /** A real runner dies long after registration — fire the end async. */
    start(): void {
      const { onEnd } = constructors[constructors.length - 1]!;
      queueMicrotask(() => onEnd?.('connect-failed'));
    }

    stop(): void {}
  }
  return { ...actual, BotRunner: FakeBotRunner };
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('BotManager respawn', () => {
  it('a connect-failed runner vacates the map and its seat respawns', async () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    room.join(); // human host, seat 1
    room.addBot(); // bot, seat 2
    const manager = new BotManager(() => 'http://127.0.0.1:1');

    manager.spawnFor(room);
    await flush(); // the runner ends connect-failed and vacates the map
    expect(manager.runnerCount('TEST')).toBe(0);

    manager.spawnFor(room); // the seat is free again — the next spawn revives it
    expect(constructors).toHaveLength(2);
    expect(manager.runnerCount('TEST')).toBe(1);
  });
});
