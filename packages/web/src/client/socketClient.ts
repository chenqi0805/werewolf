import { io, type Socket } from 'socket.io-client';
import type { PlayerAction } from '@werewolf/engine';
import type {
  ClientToServerEvents,
  CreateAck,
  JoinAck,
  OkAck,
  RejoinAck,
  ServerToClientEvents,
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

export function createRoom(socket: GameSocket): Promise<CreateAck> {
  return callAck<CreateAck>((ack) => socket.emit('room:create', ack));
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

/** Fire-and-forget: rejections arrive as `game:error`, not as an ack. */
export function sendAction(socket: GameSocket, action: PlayerAction): void {
  socket.emit('game:action', action);
}
