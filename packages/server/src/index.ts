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
  type TimerInfo,
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
export {
  currentSpeechSlot,
  gateVoiceFrame,
  handleVoiceFrame,
  VoiceHub,
  transcribeWithOpenAI,
  MAX_CHUNK_BYTES,
  MAX_BUFFER_BYTES,
  FALLBACK_DEADLINE_MS,
  OPENAI_TRANSCRIBE_URL,
  DEFAULT_STT_MODEL,
  type SpeechContext,
  type SpeechSlot,
  type SttConfig,
  type TranscribeFn,
  type VoiceOptions,
  type VoiceChunk,
  type VoiceTarget,
  type VoiceHost,
  type FrameVerdict,
} from './voice';
export {
  attachAssistant,
  resolveAssistantProvider,
  buildStrategyPrompt,
  speechRecordsOf,
  parseStrategyReply,
  stripReasoningTrace,
  validateStrategyReply,
  AssistantProviderError,
  ASSISTANT_ERROR_CODES,
  ASSISTANT_MAX_TOKENS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_MODEL,
  STRATEGY_JSON_SCHEMA,
  type StrategyReply,
  type AssistantProvider,
  type AssistantOptions,
  type AssistantAck,
  type AssistantServer,
  type AssistantSocket,
  type SpeechRecord,
} from './assistant';
export {
  attachPostgame,
  buildPostgamePrompt,
  postgameStatsOf,
  parsePostgameReply,
  validatePostgameReply,
  POSTGAME_ERROR_CODES,
  POSTGAME_MAX_TOKENS,
  POSTGAME_JSON_SCHEMA,
  type PostgameReply,
  type PostgameRating,
  type PostgameStat,
  type PostgameOptions,
  type PostgameAck,
  type PostgameServer,
  type PostgameSocket,
} from './postgame';
