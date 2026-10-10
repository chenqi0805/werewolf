/**
 * Transport-level room rejections, distinct from the engine's GameError.
 * RoomErrors surface in `room:*` acknowledgement payloads; GameErrors surface
 * as per-socket `game:error` events. Codes are stable protocol values.
 */
export type RoomErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_RUNNING'
  | 'BAD_TOKEN'
  | 'NO_SEAT'
  | 'NOT_YOUR_SEAT'
  | 'BAD_ACTION'
  | 'SERVER_ACTION_FORBIDDEN'
  | 'ROOM_NOT_FULL'
  | 'ALREADY_STARTED'
  | 'NOT_A_BOT';

export class RoomError extends Error {
  constructor(
    public readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}
