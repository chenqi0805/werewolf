import { describe, expect, it } from 'vitest';
import type { PlayerAction } from '@werewolf/engine';
import type {
  ClientToServerEvents,
  PostgameReply,
  ServerToClientEvents,
  StrategyReply,
} from '@werewolf/server';
import type { Socket } from 'socket.io-client';

import {
  ACK_TIMEOUT_MS,
  AckError,
  createRoom,
  joinRoom,
  leaveRoom,
  rejoinRoom,
  requestPostgameAnalysis,
  requestStrategy,
  sendAction,
  sendInvite,
  startGame,
} from './socketClient';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Minimal socket stand-in: records emitted args and, when a test asks,
 * answers the ack callback the wrappers register. Mirrors the runtime
 * contract of a socket.timeout() ack: the callback takes (err, resp), with
 * err = null on a server answer — timeout/disconnect settle err with a
 * bare Error instead.
 */
function fakeSocket(answer?: (event: string, args: unknown[]) => void): GameSocket & {
  emitted: Array<{ event: string; args: unknown[] }>;
  timeouts: number[];
} {
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const timeouts: number[] = [];
  const emit = (event: string, ...args: unknown[]): void => {
    emitted.push({ event, args });
    answer?.(event, args);
  };
  const socket = {
    emitted,
    timeouts,
    timeout: (ms: number): { emit: typeof emit } => {
      timeouts.push(ms);
      return { emit };
    },
    emit,
  };
  return socket as unknown as GameSocket & typeof socket;
}

/** The last arg of every C2S emit is the ack callback. */
function ackOf(socket: ReturnType<typeof fakeSocket>): (err: Error | null, resp?: unknown) => void {
  const last = socket.emitted[socket.emitted.length - 1];
  if (!last) throw new Error('nothing emitted');
  const ack = last.args[last.args.length - 1];
  if (typeof ack !== 'function') throw new Error('no ack registered');
  return ack as (err: Error | null, resp?: unknown) => void;
}

describe('socket client wrappers', () => {
  it('resolves createRoom with the ack payload', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, {
        roomCode: 'AB2C',
        seat: 1,
        sessionToken: 'tok',
      });
    });
    await expect(createRoom(socket)).resolves.toEqual({
      roomCode: 'AB2C',
      seat: 1,
      sessionToken: 'tok',
    });
    expect(socket.emitted[0]?.event).toBe('room:create');
  });

  it('rejects with AckError carrying the server code', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, { error: 'ROOM_FULL' });
    });
    const error = await joinRoom(socket, 'AB2C').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('ROOM_FULL');
  });

  it('passes the join code and rejoin token through', async () => {
    const socket = fakeSocket();
    void joinRoom(socket, 'XY9Z').catch(() => undefined);
    void rejoinRoom(socket, 'XY9Z', 'tok-2').catch(() => undefined);
    expect(socket.emitted[0]?.event).toBe('room:join');
    expect(socket.emitted[0]?.args[0]).toBe('XY9Z');
    expect(socket.emitted[1]?.event).toBe('room:rejoin');
    expect(socket.emitted[1]?.args[0]).toBe('XY9Z');
    expect(socket.emitted[1]?.args[1]).toBe('tok-2');
  });

  it('emits start and game actions without awaiting', () => {
    const socket = fakeSocket();
    void startGame(socket).catch(() => undefined);
    const action: PlayerAction = { type: 'EXILE_VOTE', actor: 2, target: null };
    sendAction(socket, action);
    expect(socket.emitted[0]?.event).toBe('room:start');
    expect(socket.emitted[1]).toMatchObject({ event: 'game:action' });
  });
});

describe('AckError promise behavior', () => {
  it('arms a timeout budget on every acked emit', () => {
    const socket = fakeSocket();
    void createRoom(socket).catch(() => undefined);
    expect(socket.timeouts).toEqual([ACK_TIMEOUT_MS]);
  });

  it('rejects with AckError TIMEOUT when the socket disconnects mid-ack', async () => {
    const socket = fakeSocket();
    const pending = createRoom(socket);
    // socket.io settles a timeout-decorated pending ack with a bare Error
    // when the transport drops before the server answers.
    ackOf(socket)(new Error('socket has been disconnected'));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('TIMEOUT');
  });

  it('rejects with AckError TIMEOUT when the ack budget expires', async () => {
    const socket = fakeSocket();
    const pending = createRoom(socket);
    ackOf(socket)(new Error('operation has timed out'));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('TIMEOUT');
  });
});

describe('requestStrategy', () => {
  const reply: StrategyReply = {
    lines: ['先报查验，再给警徽流。'],
    reasoning: '起跳预言家要第一时间占据信息位。',
    warnings: ['小心悍跳狼抢先报查杀。'],
  };

  it('emits assistant:strategy and resolves with the reply', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, reply);
    });
    await expect(requestStrategy(socket)).resolves.toEqual(reply);
    expect(socket.emitted[0]?.event).toBe('assistant:strategy');
  });

  it('rejects with AckError when the assistant is unavailable', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, {
        error: 'ASSISTANT_UNAVAILABLE',
      });
    });
    const error = await requestStrategy(socket).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('ASSISTANT_UNAVAILABLE');
  });
});

describe('sendInvite', () => {
  it('emits room:invite with the address and resolves with the ok ack', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, { ok: true });
    });
    await expect(sendInvite(socket, 'friend@example.com')).resolves.toEqual({ ok: true });
    expect(socket.emitted[0]?.event).toBe('room:invite');
    expect(socket.emitted[0]?.args[0]).toBe('friend@example.com');
  });

  it('rejects with AckError carrying the server code', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, {
        error: 'INVITE_RATE_LIMITED',
      });
    });
    const error = await sendInvite(socket, 'friend@example.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('INVITE_RATE_LIMITED');
  });
});

describe('leaveRoom', () => {
  it('emits room:leave and resolves with the ok ack', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, { ok: true });
    });
    await expect(leaveRoom(socket)).resolves.toEqual({ ok: true });
    expect(socket.emitted[0]?.event).toBe('room:leave');
  });

  it('rejects with AckError carrying the server code', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, {
        error: 'ALREADY_STARTED',
      });
    });
    const error = await leaveRoom(socket).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('ALREADY_STARTED');
  });
});

describe('requestPostgameAnalysis', () => {
  const reply: PostgameReply = {
    summary: '狼队靠警徽流误导放逐，好人核心出局后屠边失败，好人阵营险胜。',
    keyMoments: ['首夜狼刀带走2号，遗言指向7号。', '第1天放逐7号，猎人开枪带走10号。'],
    mvp: 5,
    ratings: [
      {
        seat: 5,
        score: 9,
        rationale: '全场最清晰的局面阅读。',
        highlight: '关键时刻带队放逐悍跳狼。',
      },
    ],
  };

  it('emits postgame:analysis and resolves with the shared review', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, reply);
    });
    await expect(requestPostgameAnalysis(socket)).resolves.toEqual(reply);
    expect(socket.emitted[0]?.event).toBe('postgame:analysis');
  });

  it('rejects with AckError when the game is not over', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (err: null, resp: unknown) => void)(null, {
        error: 'NOT_GAME_OVER',
      });
    });
    const error = await requestPostgameAnalysis(socket).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('NOT_GAME_OVER');
  });

  it('rejects with AckError when there is no socket', async () => {
    const error = await requestPostgameAnalysis(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('NOT_IN_ROOM');
  });
});
