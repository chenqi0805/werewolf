import { io, type Socket } from 'socket.io-client';
import type { BoardId, PlayerAction } from '@werewolf/engine';
import type {
  AddBotAck,
  ClientToServerEvents,
  CreateAck,
  JoinAck,
  OkAck,
  PostgameReply,
  RejoinAck,
  ServerToClientEvents,
  StrategyReply,
} from '@werewolf/server';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Ack came back with `{ error }` instead of a payload. */
export class AckError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AckError';
  }
}

/** Typed socket.io connection; WebSocket first, polling as the fallback. */
export function createGameSocket(): GameSocket {
  return io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 10000 });
}

type AckOf<T> = T | { error: string };

function isAckFailure(resp: unknown): resp is { error: string } {
  return (
    typeof resp === 'object' &&
    resp !== null &&
    'error' in resp &&
    typeof (resp as { error: unknown }).error === 'string'
  );
}

function callAck<T>(emit: (ack: (resp: AckOf<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    emit((resp) => {
      if (isAckFailure(resp)) {
        reject(new AckError(resp.error));
      } else {
        resolve(resp as T);
      }
    });
  });
}

export function createRoom(socket: GameSocket, board: BoardId = 'classic'): Promise<CreateAck> {
  return callAck<CreateAck>((ack) => socket.emit('room:create', { board }, ack));
}

export function joinRoom(socket: GameSocket, code: string): Promise<JoinAck> {
  return callAck<JoinAck>((ack) => socket.emit('room:join', code, ack));
}

export function rejoinRoom(socket: GameSocket, code: string, token: string): Promise<RejoinAck> {
  return callAck<RejoinAck>((ack) => socket.emit('room:rejoin', code, token, ack));
}

export function startGame(socket: GameSocket): Promise<OkAck> {
  return callAck<OkAck>((ack) => socket.emit('room:start', ack));
}

/** Lobby-only quit: frees the seat server-side; the caller resets the UI. */
export function leaveRoom(socket: GameSocket): Promise<OkAck> {
  return callAck<OkAck>((ack) => socket.emit('room:leave', ack));
}

/** Lobby-only: seat an AI player (lowest free seat, server-held token). */
export function addBot(socket: GameSocket): Promise<AddBotAck> {
  return callAck<AddBotAck>((ack) => socket.emit('room:addBot', ack));
}

/** Lobby-only: retire an AI player and free its seat. */
export function removeBot(socket: GameSocket, seat: number): Promise<OkAck> {
  return callAck<OkAck>((ack) => socket.emit('room:removeBot', seat, ack));
}

/** Ask the strategy assistant; it answers from the caller's own view or acks an error code. */
export function requestStrategy(socket: GameSocket): Promise<StrategyReply> {
  return callAck<StrategyReply>((ack) => socket.emit('assistant:strategy', ack));
}

/**
 * Ask for the finished room's shared 复盘; the server memoizes one
 * generation per room, so repeat and concurrent calls join the same answer.
 * Tolerates a missing socket — GameOverScreen's socket prop is optional and
 * the block is disabled then; this reject is the contract's safety net.
 */
export function requestPostgameAnalysis(
  socket: GameSocket | null | undefined,
): Promise<PostgameReply> {
  if (!socket) return Promise.reject(new AckError('NOT_IN_ROOM'));
  return callAck<PostgameReply>((ack) => socket.emit('postgame:analysis', ack));
}

/** Fire-and-forget: rejections arrive as `game:error`, not as an ack. */
export function sendAction(socket: GameSocket, action: PlayerAction): void {
  socket.emit('game:action', action);
}

/** Fire-and-forget: one captured mic frame from the current speech speaker. */
export function emitVoiceFrame(socket: GameSocket, chunk: ArrayBuffer): void {
  socket.emit('voice:frame', chunk);
}
