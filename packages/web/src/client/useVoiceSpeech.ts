import { useEffect, useRef, useState } from 'react';

import {
  VoiceSession,
  type VoiceRecognitionResult,
  type VoiceRecognizer,
  type VoiceSessionDeps,
  type VoiceSpeechState,
} from './voiceSession';

export type { VoiceSpeechState, VoiceSpeechStatus } from './voiceSession';

export interface UseVoiceSpeechOptions {
  /** Whether the current speech slot belongs to the viewer (gating.canSpeakNow). */
  canSpeak: boolean;
  /**
   * Identity of the current speech slot — a change means a fresh capture
   * session (screens/gating.ts speechSlotKeyOf). Null outside speech slots.
   */
  slotKey: string | null;
  /** Absolute slot deadline in ms (view.timer.endsAt); null when unclocked. */
  deadlineAtMs: number | null;
  /** Submits the slot's transcript — wired to `send({ type: 'SPEAK', … })`. */
  submit: (text: string) => void;
  /** Receives one captured frame — wired to the `voice:frame` emit. */
  onFrame: (chunk: ArrayBuffer) => void;
}

const INITIAL: VoiceSpeechState = { status: 'idle', interimText: '', finalText: '', error: null };

/**
 * Voice capture for the current speaker: microphone → MediaRecorder frames
 * (relayed via `onFrame`), Web Speech zh-CN captions, and the auto-SPEAK of
 * the joined final transcript one second before the slot deadline. All
 * browser behavior lives in the pure `VoiceSession`; this hook only supplies
 * the real implementations and drives it from prop changes.
 */
export function useVoiceSpeech(options: UseVoiceSpeechOptions): VoiceSpeechState {
  const [state, setState] = useState<VoiceSpeechState>(INITIAL);
  // Latest-callback refs: the session is constructed once and must not be
  // rebuilt (a rebuild would drop a live capture) when callers pass new
  // closures each render.
  const optionsRef = useRef(options);
  const [session] = useState(
    () =>
      new VoiceSession(browserDeps(), {
        submit: (text) => optionsRef.current.submit(text),
        onFrame: (chunk) => optionsRef.current.onFrame(chunk),
        onChange: setState,
      }),
  );

  useEffect(() => {
    optionsRef.current = options;
  });

  const { canSpeak, slotKey, deadlineAtMs } = options;
  useEffect(() => {
    if (canSpeak && slotKey !== null) {
      session.begin({ slotKey, deadlineAtMs });
    } else {
      session.end();
    }
  }, [session, canSpeak, slotKey, deadlineAtMs]);

  useEffect(() => () => session.dispose(), [session]);

  return state;
}

/** Real browser implementations for the pure session. */
function browserDeps(): VoiceSessionDeps {
  // The pure session sees only the narrow VoiceStream token; the real
  // MediaStream it wraps is what MediaRecorder needs, so it is kept here.
  let liveStream: MediaStream | null = null;
  return {
    requestMic: async () => {
      if (navigator.mediaDevices?.getUserMedia === undefined) {
        // getUserMedia only exists in secure contexts (HTTPS or localhost).
        const error = new Error('voice capture requires a secure context');
        error.name = 'InsecureContext';
        throw error;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      liveStream = stream;
      return { stop: () => stream.getTracks().forEach((track) => track.stop()) };
    },
    startRecorder: (stream, onChunk) => {
      if (typeof MediaRecorder === 'undefined' || liveStream === null) return null;
      void stream; // identity token — capture belongs to the stream above
      const mimeType = pickRecorderMimeType();
      const source = liveStream;
      const recorder =
        mimeType !== null ? new MediaRecorder(source, { mimeType }) : new MediaRecorder(source);
      // Ordered delivery: Blob.arrayBuffer() resolves asynchronously, so each
      // frame's read chains off the previous one — the relay stream must
      // arrive in recording order for the server fallback to decode it.
      let tail: Promise<void> = Promise.resolve();
      recorder.ondataavailable = (event: BlobEvent) => {
        const blob = event.data;
        if (blob.size === 0) return;
        tail = tail.then(() => blob.arrayBuffer()).then(onChunk, () => undefined); // a failed frame read never kills the chain
      };
      recorder.start(250); // webm/opus frames every 250ms — the relay cadence
      return {
        stop: () => {
          if (recorder.state !== 'inactive') recorder.stop();
        },
      };
    },
    makeRecognizer: () => {
      const ctor =
        typeof SpeechRecognition !== 'undefined'
          ? SpeechRecognition
          : (window.webkitSpeechRecognition ?? null);
      if (ctor === null) return null;
      const engine = new ctor();
      engine.lang = 'zh-CN';
      engine.continuous = true;
      engine.interimResults = true;
      const recognizer: VoiceRecognizer = {
        onresult: null,
        onerror: null,
        onend: null,
        start: () => engine.start(),
        stop: () => engine.stop(),
      };
      engine.onresult = (event) => recognizer.onresult?.(toVoiceResult(event));
      engine.onerror = (event) => recognizer.onerror?.(event.error);
      engine.onend = () => recognizer.onend?.();
      return recognizer;
    },
    schedule: (fn, ms) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
    now: () => Date.now(),
  };
}

/** Prefer webm/opus; fall back to the browser default when unsupported. */
function pickRecorderMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return null;
}

/** DOM recognition event → the new final/interim items since the last one. */
function toVoiceResult(event: SpeechRecognitionEvent): VoiceRecognitionResult {
  const items: Array<{ isFinal: boolean; transcript: string }> = [];
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    if (result === undefined) continue;
    items.push({ isFinal: result.isFinal, transcript: result[0]?.transcript ?? '' });
  }
  return { items };
}
