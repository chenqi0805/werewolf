/**
 * @werewolf/server — the Socket.IO room server.
 *
 * Owns transport, pacing, and per-seat view projection. Holds no rule
 * knowledge of its own: every mutation goes through the engine's
 * applyAction, and every client payload is a projection built here. The
 * PlayerAction protocol is the seam phase-two AI bots plug into.
 */
export { Room, RoomRegistry, type Applied, type RoomOptions, type SeatRecord } from './room';
export { RoomError, type RoomErrorCode } from './errors';
export { shuffledDeck } from './deck';
export { makeRoomCode, makeToken } from './ids';
export { defaultActionsFor, clockKey, DEFAULT_TIMERS } from './defaults';
export {
  viewFor,
  eventsForSeat,
  type PlayerView,
  type PlayerRow,
  type StepView,
  type YouView,
  type WitchPotionView,
} from './view';
export {
  attachGateway,
  createApp,
  type AppHandle,
  type GatewayOptions,
  type TimerOverrides,
  type CreateAck,
  type JoinAck,
  type RejoinAck,
  type OkAck,
  type ErrorPayload,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type SocketData,
} from './gateway';
