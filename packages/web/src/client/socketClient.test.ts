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
  AckError,
  createRoom,
  joinRoom,
  leaveRoom,
  rejoinRoom,
  requestPostgameAnalysis,
  requestStrategy,
  sendAction,
  startGame,
} from './socketClient';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Minimal socket stand-in: records emitted args and, when a test asks,
 * answers the ack callback the wrappers register.
 */
function fakeSocket(answer?: (event: string, args: unknown[]) => void): GameSocket & {
  emitted: Array<{ event: string; args: unknown[] }>;
} {
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const socket = {
    emitted,
    emit: (event: string, ...args: unknown[]): void => {
      emitted.push({ event, args });
      answer?.(event, args);
    },
  };
  return socket as unknown as GameSocket & typeof socket;
}

/** The last arg of every C2S emit is the ack callback. */
function ackOf(socket: ReturnType<typeof fakeSocket>): (resp: unknown) => void {
  const last = socket.emitted[socket.emitted.length - 1];
  if (!last) throw new Error('nothing emitted');
  const ack = last.args[last.args.length - 1];
  if (typeof ack !== 'function') throw new Error('no ack registered');
  return ack as (resp: unknown) => void;
}

describe('socket client wrappers', () => {
  it('resolves createRoom with the ack payload', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (resp: unknown) => void)({
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
      (args[args.length - 1] as (resp: unknown) => void)({ error: 'ROOM_FULL' });
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
  it('stays pending until the ack fires', async () => {
    const socket = fakeSocket();
    let settled = false;
    const pending = createRoom(socket).then((v) => {
      settled = true;
      return v;
    });
    expect(settled).toBe(false);
    ackOf(socket)({ roomCode: 'AB2C', seat: 1, sessionToken: 'tok' });
    await pending;
    expect(settled).toBe(true);
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
      (args[args.length - 1] as (resp: unknown) => void)(reply);
    });
    await expect(requestStrategy(socket)).resolves.toEqual(reply);
    expect(socket.emitted[0]?.event).toBe('assistant:strategy');
  });

  it('rejects with AckError when the assistant is unavailable', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (resp: unknown) => void)({ error: 'ASSISTANT_UNAVAILABLE' });
    });
    const error = await requestStrategy(socket).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AckError);
    expect((error as AckError).code).toBe('ASSISTANT_UNAVAILABLE');
  });
});

describe('leaveRoom', () => {
  it('emits room:leave and resolves with the ok ack', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (resp: unknown) => void)({ ok: true });
    });
    await expect(leaveRoom(socket)).resolves.toEqual({ ok: true });
    expect(socket.emitted[0]?.event).toBe('room:leave');
  });

  it('rejects with AckError carrying the server code', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (resp: unknown) => void)({ error: 'ALREADY_STARTED' });
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
      (args[args.length - 1] as (resp: unknown) => void)(reply);
    });
    await expect(requestPostgameAnalysis(socket)).resolves.toEqual(reply);
    expect(socket.emitted[0]?.event).toBe('postgame:analysis');
  });

  it('rejects with AckError when the game is not over', async () => {
    const socket = fakeSocket((_event, args) => {
      (args[args.length - 1] as (resp: unknown) => void)({ error: 'NOT_GAME_OVER' });
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
