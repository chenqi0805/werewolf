/**
 * Pure voice-capture session: the state machine behind `useVoiceSpeech`.
 *
 * Everything the browser supplies arrives injected — microphone access, the
 * Web Speech recognizer, timers — so the whole lifecycle (requesting, live
 * captions, the deadline auto-submit, slot teardown) unit-tests with
 * hand-rolled doubles, per the repo's no-DOM test convention. The React hook
 * at the bottom of the import chain only wires real browser APIs in.
 *
 * One session covers one speech slot: `begin` when the slot becomes mine,
 * `end` when it leaves this seat. Between the two, the session captures mic
 * audio (relayed out as frames), accumulates Web Speech transcripts, and
 * auto-submits the joined final text ~1s before the slot deadline. Silence
 * never submits — the slot passes and the server's own fallback decides.
 */

/** Matches the server's gateway MAX_SPEECH_LENGTH — the transcript of record. */
export const MAX_SPEECH_LENGTH = 2000;

/** The auto-submit fires this long before the slot deadline. */
export const SUBMIT_MARGIN_MS = 1_000;

/**
 * Composer status. `语音不可用` renders for `unavailable` (mic denied or
 * capture missing) and `未发言` for `silent` (the slot ended with nothing
 * submitted); `unsupported` means no Web Speech captions here — capture
 * still relays frames and the server-side STT fallback is authoritative.
 */
export type VoiceSpeechStatus =
  'idle' | 'requesting' | 'recording' | 'submitted' | 'unavailable' | 'silent' | 'unsupported';

export interface VoiceSpeechState {
  status: VoiceSpeechStatus;
  /** The trailing hypothesis that has not finalized yet. */
  interimText: string;
  /** Finalized transcript segments, in speech order. */
  finalText: string;
  /** Human-readable detail for the failure behind `unavailable`, if any. */
  error: string | null;
}

/** One recognition callback: the new items since the last event. */
export interface VoiceRecognitionResult {
  items: ReadonlyArray<{ isFinal: boolean; transcript: string }>;
}

/** The recognizer slice the session drives — adapted from the DOM surface. */
export interface VoiceRecognizer {
  onresult: ((result: VoiceRecognitionResult) => void) | null;
  onerror: ((message: string) => void) | null;
  /** Fired when the engine stops on its own (silence, service hiccup). */
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export type VoiceRecognizerFactory = () => VoiceRecognizer | null;

/** A captured stream, narrowed to the release the session needs. */
export interface VoiceStream {
  stop(): void;
}

/** A chunked recorder, narrowed to the teardown the session needs. */
export interface VoiceRecorder {
  stop(): void;
}

export interface VoiceSessionDeps {
  /** Opens the microphone; rejects when permission or hardware is missing. */
  requestMic(): Promise<VoiceStream>;
  /**
   * Starts chunked recording (the real hook: MediaRecorder webm/opus, 250ms
   * slices). Null when the platform has no recorder — captions can still run.
   */
  startRecorder(stream: VoiceStream, onChunk: (chunk: ArrayBuffer) => void): VoiceRecorder | null;
  /** A fresh Web Speech recognizer, or null when the browser lacks one. */
  makeRecognizer(): VoiceRecognizer | null;
  /** Timeout seam; the returned function cancels the pending callback. */
  schedule(fn: () => void, ms: number): () => void;
  /** Wall clock in ms, on the same base as the `deadlineAtMs` handed to begin. */
  now(): number;
}

export interface VoiceSessionHandlers {
  /** Wire out: the slot's transcript (the hook sends the SPEAK action). */
  submit(text: string): void;
  /** Wire out: one captured audio frame (the hook emits `voice:frame`). */
  onFrame(chunk: ArrayBuffer): void;
  /** Wire in: every state change, already copied. */
  onChange(state: VoiceSpeechState): void;
}

export interface VoiceSessionOptions {
  slotKey: string;
  /** Absolute slot deadline in ms; null when the phase runs without a clock. */
  deadlineAtMs: number | null;
}

const IDLE: VoiceSpeechState = { status: 'idle', interimText: '', finalText: '', error: null };

/**
 * One capture session per speech slot. All state lives behind `current()`
 * and `onChange` — no React, no DOM, no timers of its own.
 */
export class VoiceSession {
  private key: string | null = null;
  private state: VoiceSpeechState = IDLE;
  private stream: VoiceStream | null = null;
  private recorder: VoiceRecorder | null = null;
  private recognizer: VoiceRecognizer | null = null;
  private cancelSubmit: (() => void) | null = null;
  /** True once this slot's transcript went out — late frames/results drop. */
  private submitted = false;
  /** True once the slot ended — late mic grants release without starting. */
  private ended = true;

  constructor(
    private readonly deps: VoiceSessionDeps,
    private readonly handlers: VoiceSessionHandlers,
  ) {}

  get slotKey(): string | null {
    return this.key;
  }

  current(): VoiceSpeechState {
    return this.state;
  }

  /** Starts a fresh capture session for a new slot; same-key calls are no-ops. */
  begin(opts: VoiceSessionOptions): void {
    if (this.key === opts.slotKey) return;
    this.teardownCapture();
    this.key = opts.slotKey;
    this.submitted = false;
    this.ended = false;
    this.set({ status: 'requesting', interimText: '', finalText: '', error: null });

    const recognizer = this.deps.makeRecognizer();
    if (recognizer === null) {
      // No Web Speech captions here — capture still relays frames and the
      // server fallback stays authoritative for this seat.
      this.recognizer = null;
      this.patch({ status: 'unsupported' });
    } else {
      this.recognizer = recognizer;
      recognizer.onresult = (result) => this.onResult(result);
      recognizer.onerror = (message) => this.patch({ error: `转写不可用（${message}）` });
      recognizer.onend = () => this.restartRecognizer();
      try {
        recognizer.start();
      } catch (error) {
        // A synchronous start failure kills captions, not capture.
        this.patch({ error: micErrorMessage(error) });
      }
    }

    if (opts.deadlineAtMs !== null) {
      const delay = Math.max(0, opts.deadlineAtMs - SUBMIT_MARGIN_MS - this.deps.now());
      this.cancelSubmit = this.deps.schedule(() => this.submitForDeadline(), delay);
    }
    void this.requestMic();
  }

  /**
   * Ends the session because the slot left this seat (or the phase moved on).
   * Releases the microphone; a submitted transcript stays `submitted`, a mic
   * failure stays `unavailable`, everything else becomes 未发言 (`silent`).
   */
  end(): void {
    if (this.key === null) return;
    this.ended = true;
    this.teardownCapture();
    const { status } = this.state;
    if (status !== 'submitted' && status !== 'unavailable' && status !== 'idle') {
      this.patch({ status: 'silent' });
    }
  }

  /** Final teardown: releases everything and forgets the slot. */
  dispose(): void {
    this.ended = true;
    this.teardownCapture();
    this.key = null;
  }

  private async requestMic(): Promise<void> {
    try {
      const stream = await this.deps.requestMic();
      if (this.ended) {
        // The prompt outlived the slot — release immediately.
        stream.stop();
        return;
      }
      this.stream = stream;
      this.recorder = this.deps.startRecorder(stream, (chunk) => {
        if (!this.ended && !this.submitted) this.handlers.onFrame(chunk);
      });
      if (this.state.status === 'requesting') {
        this.patch({ status: this.recognizer === null ? 'unsupported' : 'recording' });
      }
    } catch (error) {
      if (this.ended) return;
      this.patch({ status: 'unavailable', error: micErrorMessage(error) });
      this.stopRecognizer();
    }
  }

  private onResult(result: VoiceRecognitionResult): void {
    if (this.ended || this.submitted) return;
    let finals = '';
    let interim = '';
    for (const item of result.items) {
      if (item.isFinal) finals += item.transcript;
      else interim += item.transcript;
    }
    this.patch({
      finalText: this.state.finalText + finals,
      interimText: interim,
    });
  }

  /** The slot deadline minus the margin: auto-submit the joined transcript. */
  private submitForDeadline(): void {
    this.cancelSubmit = null;
    if (this.ended || this.submitted) return;
    const joined = `${this.state.finalText}${this.state.interimText}`.trim();
    if (joined.length === 0) return; // silence path: never submit, never stall
    this.submitted = true;
    this.patch({ status: 'submitted', interimText: '' });
    this.handlers.submit(joined.slice(0, MAX_SPEECH_LENGTH));
    // The transcript of record is out — capture has done its job.
    this.teardownCapture();
  }

  /** Chrome ends the engine after silence pauses; pick it back up mid-slot. */
  private restartRecognizer(): void {
    const recognizer = this.recognizer;
    if (recognizer === null || this.ended || this.submitted) return;
    try {
      recognizer.start();
    } catch {
      // Already started or service gone — captions end, capture continues.
    }
  }

  private stopRecognizer(): void {
    const recognizer = this.recognizer;
    this.recognizer = null;
    if (recognizer === null) return;
    recognizer.onresult = null;
    recognizer.onerror = null;
    recognizer.onend = null;
    try {
      recognizer.stop();
    } catch {
      // Stopping a never-started engine is a no-op elsewhere.
    }
  }

  /** Stops every capture resource; never touches the visible status. */
  private teardownCapture(): void {
    if (this.cancelSubmit !== null) {
      this.cancelSubmit();
      this.cancelSubmit = null;
    }
    this.stopRecognizer();
    if (this.recorder !== null) {
      const recorder = this.recorder;
      this.recorder = null;
      try {
        recorder.stop();
      } catch {
        // A recorder that never started cannot stop — nothing to save.
      }
    }
    if (this.stream !== null) {
      const stream = this.stream;
      this.stream = null;
      stream.stop(); // release the microphone the moment capture stops
    }
  }

  private set(next: VoiceSpeechState): void {
    this.state = next;
    this.handlers.onChange(next);
  }

  private patch(partial: Partial<VoiceSpeechState>): void {
    this.set({ ...this.state, ...partial });
  }
}

/** Human-readable reason behind a rejected `requestMic`. */
function micErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'InsecureContext') return '需要 HTTPS（或 localhost）才能使用语音';
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return '麦克风权限被拒绝';
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return '未检测到麦克风设备';
    }
    return `麦克风不可用（${error.name}）`;
  }
  return '麦克风不可用';
}
