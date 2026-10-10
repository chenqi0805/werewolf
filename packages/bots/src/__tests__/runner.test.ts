import type { Seat } from '@werewolf/engine';
import type { PlayerRow, PlayerView, StepView, YouView } from '@werewolf/server';
import type { Socket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';

import { BotRunner, type BotEndReason } from '../runner';
import type { BotStrategy } from '../strategy';

// — socket.io-client mock — the runner is the only importer; tests drive the
// server side of the wire directly on each fake socket. —

const ioMock = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({ io: ioMock }));

type SocketHandler = (...args: unknown[]) => void;

/**
 * Socket stand-in: records emits, lets tests fire server-side events, and
 * never dials anything. `fire` mirrors the wire — handlers registered before
 * `removeAllListeners` are gone, which is exactly the lifecycle under test.
 */
class FakeSocket {
  readonly emitted: { event: string; args: unknown[] }[] = [];
  /** Timeout budgets the runner armed on acked emits. */
  readonly timeouts: number[] = [];
  disconnected = false;
  private readonly listeners = new Map<string, SocketHandler[]>();

  on(event: string, handler: SocketHandler): this {
    return this.track(event, handler);
  }

  once(event: string, handler: SocketHandler): this {
    return this.track(event, handler);
  }

  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }

  timeout(ms: number): { emit: (event: string, ...args: unknown[]) => void } {
    return {
      emit: (event, ...args) => {
        this.timeouts.push(ms);
        this.emitted.push({ event, args });
      },
    };
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Server side: deliver an event to the runner's handlers. */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(...args);
  }

  private track(event: string, handler: SocketHandler): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(handler);
    this.listeners.set(event, existing);
    return this;
  }
}

/** The socket the runner's next connection attempt will receive. */
function nextSocket(): FakeSocket {
  const socket = new FakeSocket();
  ioMock.mockReturnValueOnce(socket as unknown as Socket<never, never>);
  return socket;
}

function emitsOf(socket: FakeSocket, event: string): { event: string; args: unknown[] }[] {
  return socket.emitted.filter((e) => e.event === event);
}

/** The rejoin ack callback the runner registered on the last room:rejoin emit. */
function rejoinAckOf(socket: FakeSocket): (...args: unknown[]) => void {
  const all = emitsOf(socket, 'room:rejoin');
  const last = all[all.length - 1];
  if (!last) throw new Error('no room:rejoin emitted');
  const ack = last.args[last.args.length - 1];
  if (typeof ack !== 'function') throw new Error('no ack registered');
  return ack as (...args: unknown[]) => void;
}

// — view/strategy builders — the same fog-of-war shapes the other suites use —

function row(seat: Seat): PlayerRow {
  return {
    seat,
    name: '',
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 1,
    occupied: true,
    isBot: false,
    botName: null,
    role: null,
  };
}

function you(seat: Seat): YouView {
  return {
    seat,
    role: 'villager',
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 1,
  };
}

function viewOf(step: StepView): PlayerView {
  return {
    phase: step.kind === 'game-over' ? 'game-over' : 'speech',
    dayNumber: 1,
    winner: step.kind === 'game-over' ? 'good' : null,
    board: 'classic',
    you: you(3),
    players: [row(1), row(2), row(3)],
    step,
    log: [],
    timer: null,
  };
}

/** Strategy that never acts but counts how often it was asked. */
function silentStrategy(): BotStrategy & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    decide: () => {
      calls += 1;
      return Promise.resolve(null);
    },
  };
}

function runnerOf(opts: {
  strategy: BotStrategy;
  onEnd?: (reason: BotEndReason) => void;
}): BotRunner {
  return new BotRunner({
    url: 'http://127.0.0.1:1',
    roomCode: 'TEST',
    token: 'tok',
    strategy: opts.strategy,
    onEnd: opts.onEnd,
    maxConnectAttempts: 3,
    connectRetryMs: 5,
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('BotRunner', () => {
  it('stop() during an in-flight connect leaves no socket and fires onEnd exactly once', async () => {
    const onEnd = vi.fn();
    const strategy = silentStrategy();
    const runner = runnerOf({ strategy, onEnd });
    const socket = nextSocket();
    runner.start();
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(socket.disconnected).toBe(false);

    runner.stop(); // the connect is still in flight — nothing attached yet
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('stopped');
    expect(socket.disconnected).toBe(true);

    // The abandoned attempt completes anyway: the server connects, acks the
    // rejoin normally, and a game-over broadcast lands. None of it may
    // resurrect the runner or re-fire onEnd.
    socket.fire('connect');
    if (emitsOf(socket, 'room:rejoin').length > 0) {
      rejoinAckOf(socket)({ seat: 3, name: '' });
    }
    socket.fire('game:view', viewOf({ kind: 'game-over' }));
    await flush();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(strategy.calls()).toBe(0);

    runner.stop(); // idempotent — no second end
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
