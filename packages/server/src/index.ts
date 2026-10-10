/**
 * @werewolf/server — the Socket.IO room server.
 *
 * Owns transport, pacing, and per-seat view projection. Holds no rule
 * knowledge of its own: every mutation goes through the engine's
 * applyAction, and every client payload is a projection built here. The
 * PlayerAction protocol is the seam phase-two AI bots plug into.
 */
export {
  Room,
  RoomRegistry,
  type Applied,
  type RoomOptions,
  type SeatRecord,
  type SeatIdentity,
  type ActionSource,
  type RoomHooks,
  type SeatRow,
} from './room';
export { RoomError, type RoomErrorCode } from './errors';
export {
  DEFAULT_LIMITS,
  IpWindowLimiter,
  parseLimits,
  type LimitOverrides,
  type Limits,
} from './limits';
export { shuffledDeck } from './deck';
export { makeRoomCode, makeToken, hashToken } from './ids';
export {
  EventStore,
  type RoomStatus,
  type SeatKind,
  type RoomRowRaw,
  type ActionRowRaw,
  type SeatRowRaw,
  type TimerRowRaw,
} from './eventStore';
export {
  restoreRooms,
  storeHooksFor,
  roomStatusOf,
  roomAssignmentsOf,
  type RestoreSummary,
} from './persistence';
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
  corsPolicyFor,
  createApp,
  type Ack,
  type AppHandle,
  type CorsPolicy,
  type GatewayOptions,
  type TimerOverrides,
  type CreateAck,
  type JoinAck,
  type RejoinAck,
  type OkAck,
  type AddBotAck,
  type ErrorPayload,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type SocketData,
} from './gateway';
export { BotManager } from './bots';
export { BOT_NICKNAMES, pickBotNickname } from './botNames';
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
export {
  attachInvites,
  resolveInviteSender,
  resendMailSender,
  buildInviteEmail,
  validatePublicBaseUrl,
  isValidInviteEmail,
  InviteProviderError,
  INVITE_ERROR_CODES,
  MAX_EMAIL_LENGTH,
  MAX_INVITES_PER_LOBBY,
  DEFAULT_INVITE_FROM,
  RESEND_ENDPOINT,
  type MailSender,
  type InviteOptions,
  type InvitesAttachment,
  type InviteAck,
  type InviteServer,
  type InviteSocket,
} from './invites';
