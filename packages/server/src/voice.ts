import type { GameEvent, GameState, Seat } from '@werewolf/engine';
import type { RoomRegistry } from './room';

/**
 * Voice relay, per-slot audio buffering, and the server-side STT fallback.
 *
 * Audio never enters GameState (every applyAction deep-clones it): frames are
 * relayed socket-to-socket, mirrored into a small per-slot buffer, and
 * discarded after the slot's fallback decision. The transcript of record is
 * the SPEAK action the slot produces — either the client's Web Speech text or
 * the server fallback transcribing the same audio the room just relayed.
 */

/** The four contexts where the engine accepts SPEAK (engine day.ts handleSpeak). */
export type SpeechContext = Extract<GameEvent, { type: 'SPEECH_MADE' }>['context'];

/** The seat currently holding a speech slot, with a stable per-slot identity. */
export interface SpeechSlot {
  seat: Seat;
  context: SpeechContext;
  /**
   * Identity of this exact slot: context + log length at detection time. No
   * action is accepted while a slot stays open (frames are not actions), so
   * the log length only moves when the slot ends — a client SPEAK grows the
   * log, which is exactly how "someone already spoke here" is detected.
   */
  key: string;
}

/**
 * Mirrors the engine's SPEAK gate (day.ts handleSpeak): the expected seat of
 * whichever speech context is open. `speech` with no direction set accepts
 * nobody, and last-words slots are spoken by the seat that just died — the
 * occupant match is the only rule.
 */
export function currentSpeechSlot(state: GameState): SpeechSlot | null {
  const key = (seat: Seat, context: SpeechContext): SpeechSlot => ({
    seat,
    context,
    key: `${context}@${state.log.length}`,
  });
  switch (state.phase) {
    case 'sheriff-speech': {
      const el = state.election;
      if (!el) return null;
      const seat = el.speechQueue[el.speechCursor];
      return seat === undefined ? null : key(seat, 'sheriff-speech');
    }
    case 'last-words': {
      const lw = state.lastWords;
      if (!lw) return null;
      const seat = lw.queue[lw.cursor];
      return seat === undefined ? null : key(seat, 'last-words');
    }
    case 'speech': {
      const sp = state.speech;
      if (!sp || sp.order === null) return null;
      const seat = sp.order[sp.cursor];
      return seat === undefined ? null : key(seat, 'speech');
    }
    case 'pk-speech': {
      const pk = state.pk;
      if (!pk) return null;
      const seat = pk.tied[pk.cursor];
      return seat === undefined ? null : key(seat, 'pk-speech');
    }
    default:
      return null;
  }
}

/** Single relayed frame — the speaker's own socket is excluded by the sender gate. */
export const MAX_CHUNK_BYTES = 64 * 1024;

/** Per-slot audio buffer ceiling — the fallback transcript never needs more. */
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/** The pending PROCEED defers at most this long for a fallback transcript. */
export const FALLBACK_DEADLINE_MS = 6_000;

export const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Default fallback model — the cheapest OpenAI transcription tier. */
export const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';

export interface SttConfig {
  provider: 'openai';
  apiKey: string;
  model: string;
  language: 'zh-CN';
}

export type TranscribeFn = (
  audio: Uint8Array,
  stt: SttConfig,
  signal: AbortSignal,
) => Promise<string | null>;

export interface VoiceOptions {
  /**
   * Server-side STT fallback; unset = relay only, and slots without a client
   * transcript pass silently. The buffer only exists when this is armed.
   */
  stt?: SttConfig;
  /** Test seam: replace the OpenAI HTTP call. Never set in production. */
  transcribe?: TranscribeFn;
  /** Test seam: hard deadline for the fallback transcript (default 6 s). */
  fallbackTimeoutMs?: number;
}

export interface VoiceChunk {
  seat: Seat;
  seq: number;
  data: ArrayBuffer;
}

/** Anything the relay fans chunks out to — the gateway's per-room sockets fit. */
export interface VoiceTarget {
  emit(event: 'voice:chunk', payload: VoiceChunk): void;
}

export interface VoiceHost {
  socketsOf(roomCode: string): Iterable<VoiceTarget>;
}

export type FrameVerdict =
  | { ok: true; slot: SpeechSlot; bytes: Uint8Array; wire: ArrayBuffer }
  | {
      ok: false;
      reason: 'NO_SEAT' | 'WRONG_PHASE' | 'NOT_YOUR_TURN' | 'BAD_CHUNK' | 'CHUNK_TOO_LARGE';
    };

/**
 * The relay gate: only the current speaker of a speech slot may send a frame,
 * and the frame must be a non-empty binary chunk within the size cap.
 * Violations are dropped silently — the gate is a mirror of the engine's own
 * SPEAK check, run before the engine ever sees a byte.
 */
export function gateVoiceFrame(
  slot: SpeechSlot | null,
  seat: Seat | null,
  chunk: unknown,
): FrameVerdict {
  if (seat === null) return { ok: false, reason: 'NO_SEAT' };
  if (slot === null) return { ok: false, reason: 'WRONG_PHASE' };
  if (slot.seat !== seat) return { ok: false, reason: 'NOT_YOUR_TURN' };
  if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
    return { ok: false, reason: 'BAD_CHUNK' };
  }
  const view =
    chunk instanceof ArrayBuffer
      ? new Uint8Array(chunk)
      : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (view.byteLength === 0) return { ok: false, reason: 'BAD_CHUNK' };
  if (view.byteLength > MAX_CHUNK_BYTES) return { ok: false, reason: 'CHUNK_TOO_LARGE' };
  return { ok: true, slot, bytes: view, wire: toArrayBuffer(view) };
}

/**
 * Consumes one gated frame: stamps the relay sequence (fresh per slot) and,
 * when the STT fallback is armed, mirrors the bytes into the slot buffer.
 * Frames are only buffered for the fallback path — there is no recording.
 */
export class VoiceHub {
  private readonly rooms = new Map<string, RoomVoice>();

  constructor(
    private readonly host: VoiceHost,
    private readonly opts: VoiceOptions = {},
  ) {}

  fallbackArmed(): boolean {
    return this.opts.stt !== undefined;
  }

  socketsOf(roomCode: string): Iterable<VoiceTarget> {
    return this.host.socketsOf(roomCode);
  }

  /** Relay sequence for this frame — monotonic within a slot, resets on slot change. */
  noteFrame(roomCode: string, slot: SpeechSlot, bytes: Uint8Array): number {
    let rv = this.rooms.get(roomCode);
    if (rv === undefined || rv.slotKey !== slot.key) {
      rv = { slotKey: slot.key, chunks: [], total: 0, seq: 0 };
      this.rooms.set(roomCode, rv);
    }
    rv.seq += 1;
    if (this.opts.stt !== undefined && rv.total + bytes.byteLength <= MAX_BUFFER_BYTES) {
      rv.chunks.push(bytes);
      rv.total += bytes.byteLength;
    }
    return rv.seq;
  }

  /**
   * Takes the slot's buffered audio for the fallback decision; null when the
   * slot's frames never landed (or belong to an older slot — the client
   * SPEAK-first rule moves the slot identity). The buffer is consumed either
   * way: audio never outlives its slot.
   */
  takeBuffer(roomCode: string, slotKey: string): Uint8Array | null {
    const rv = this.rooms.get(roomCode);
    this.rooms.delete(roomCode);
    if (rv === undefined || rv.slotKey !== slotKey || rv.chunks.length === 0) return null;
    return concatBytes(rv.chunks, rv.total);
  }

  /**
   * Drops a room's buffered audio outright — the slot it belonged to closed
   * without a fallback decision (client SPEAK, game over). Audio never
   * outlives its slot, on any path.
   */
  dropRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
  }

  dropAll(): void {
    this.rooms.clear();
  }

  /**
   * Transcribes buffered audio under a hard deadline. Timeout and provider
   * failure both yield null — the slot then passes silently, never stalls.
   */
  async transcribe(audio: Uint8Array): Promise<string | null> {
    const stt = this.opts.stt;
    if (!stt || audio.byteLength === 0) return null;
    const timeoutMs = this.opts.fallbackTimeoutMs ?? FALLBACK_DEADLINE_MS;
    const controller = new AbortController();
    let deadline: NodeJS.Timeout | undefined;
    try {
      const fn = this.opts.transcribe ?? transcribeWithOpenAI;
      return await new Promise<string | null>((resolve) => {
        deadline = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
        fn(audio, stt, controller.signal).then(resolve, (error: unknown) => {
          console.error('[werewolf] voice: STT fallback failed:', error);
          resolve(null);
        });
      });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }
}

/**
 * The OpenAI fallback call. The browser client relays MediaRecorder output
 * (webm/opus by default); the relayed chunks concatenated in arrival order
 * form one decodable stream, so the buffer is sent as a single webm blob.
 */
export async function transcribeWithOpenAI(
  audio: Uint8Array,
  stt: SttConfig,
  signal: AbortSignal,
): Promise<string | null> {
  const form = new FormData();
  form.append('file', new Blob([toArrayBuffer(audio)], { type: 'audio/webm' }), 'speech.webm');
  form.append('model', stt.model);
  // OpenAI's transcription language is ISO-639-1 — 'zh', not 'zh-CN'.
  form.append('language', stt.language.split('-')[0] ?? 'zh');
  const response = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stt.apiKey}` },
    body: form,
    signal,
  });
  if (!response.ok) {
    console.error(`[werewolf] voice: OpenAI STT failed with HTTP ${response.status}`);
    return null;
  }
  const parsed: unknown = await response.json();
  if (typeof parsed === 'object' && parsed !== null) {
    const text = (parsed as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * One gated frame from the wire: gate it against the room's current slot,
 * buffer it for the fallback, and relay it to every other socket in the room
 * — players, the dead, spectators — never the sender (no echo).
 */
export function handleVoiceFrame(
  hub: VoiceHub,
  registry: Pick<RoomRegistry, 'get'>,
  roomCode: string | null,
  seat: Seat | null,
  sender: VoiceTarget,
  chunk: unknown,
): void {
  if (roomCode === null || seat === null) return;
  const room = registry.get(roomCode);
  if (!room) return;
  const verdict = gateVoiceFrame(room.currentSpeechSlot(), seat, chunk);
  if (!verdict.ok) return;
  const seq = hub.noteFrame(roomCode, verdict.slot, verdict.bytes);
  const payload: VoiceChunk = { seat, seq, data: verdict.wire };
  for (const target of hub.socketsOf(roomCode)) {
    if (target === sender) continue;
    target.emit('voice:chunk', payload);
  }
}

interface RoomVoice {
  slotKey: string;
  chunks: Uint8Array[];
  total: number;
  seq: number;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A standalone ArrayBuffer copy — the relay wire type and the Blob part. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
