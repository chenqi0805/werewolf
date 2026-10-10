import { describe, expect, it } from 'vitest';

import {
  MAX_SPEECH_LENGTH,
  SUBMIT_MARGIN_MS,
  VoiceSession,
  type VoiceRecognitionResult,
  type VoiceRecognizer,
  type VoiceSessionDeps,
  type VoiceStream,
} from './voiceSession';

/**
 * Hand-rolled doubles only — the repo's pure-logic test convention. The
 * recognizer double mirrors the Chrome semantics the session depends on:
 * finalized segments arrive once, the trailing hypothesis stays interim.
 */

type EmittableRecognizer = VoiceRecognizer & {
  starts: number[];
  emitResult(items: VoiceRecognitionResult['items']): void;
  emitError(message: string): void;
  emitEnd(): void;
};

/** Recognizer double: the test drives its events directly. */
function fakeRecognizer(): EmittableRecognizer {
  const rec: EmittableRecognizer = {
    onresult: null,
    onerror: null,
    onend: null,
    starts: [],
    start(): void {
      rec.starts.push(rec.starts.length);
    },
    stop(): void {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
    },
    emitResult(items: VoiceRecognitionResult['items']): void {
      rec.onresult?.({ items });
    },
    emitError(message: string): void {
      rec.onerror?.(message);
    },
    emitEnd(): void {
      rec.onend?.();
    },
  };
  return rec;
}

interface SessionHarness {
  session: VoiceSession;
  recognizer: EmittableRecognizer;
  emitFrame(bytes: number): void;
  frames: ArrayBuffer[];
  submitted: string[];
  scheduled: Array<{ delay: number; fire(): void; cancel(): void }>;
  statuses: string[];
  streamStops: number;
  recorderStops: number;
  nowMs: number;
  /** Streams handed to startRecorder, in adoption order. */
  recorderStreams: VoiceStream[];
  grantsPending(): number;
  grantMic(index?: number): void;
  rejectMic(index?: number, error?: Error): void;
}

function makeSession(opts?: {
  recognizer?: VoiceRecognizer | null;
  mic?: 'ok' | 'denied';
  /** Hold requestMic promises until grantMic/rejectMic release them. */
  deferMic?: boolean;
}): SessionHarness {
  const recognizer = opts?.recognizer === undefined ? fakeRecognizer() : opts.recognizer;
  const grants: Array<(stream: VoiceStream) => void> = [];
  const rejections: Array<(error: Error) => void> = [];
  const harness: SessionHarness = {
    session: null as unknown as VoiceSession,
    recognizer: null as unknown as EmittableRecognizer,
    emitFrame: () => undefined,
    frames: [],
    submitted: [],
    scheduled: [],
    statuses: [],
    streamStops: 0,
    recorderStops: 0,
    nowMs: 100_000,
    recorderStreams: [],
    grantsPending: () => grants.length,
    grantMic: (index = 0) => grants[index]?.({ stop: () => void harness.streamStops++ }),
    rejectMic: (index = 0, error = new Error('denied')) => rejections[index]?.(error),
  };
  let emitChunk: ((chunk: ArrayBuffer) => void) | null = null;
  if (recognizer !== null) harness.recognizer = recognizer as EmittableRecognizer;
  const deps: VoiceSessionDeps = {
    requestMic: () => {
      if (opts?.mic === 'denied') {
        const error = new Error('denied');
        error.name = 'NotAllowedError';
        return Promise.reject(error);
      }
      if (opts?.deferMic === true) {
        return new Promise<VoiceStream>((resolve, reject) => {
          grants.push(resolve);
          rejections.push(reject);
        });
      }
      return Promise.resolve({ stop: () => void harness.streamStops++ });
    },
    startRecorder: (stream, onChunk) => {
      harness.recorderStreams.push(stream);
      emitChunk = onChunk;
      return { stop: () => void harness.recorderStops++ };
    },
    makeRecognizer: () => recognizer,
    schedule: (fn, ms) => {
      let cancelled = false;
      const entry = {
        delay: ms,
        fire: () => {
          if (!cancelled) fn();
        },
        cancel: () => {
          cancelled = true;
        },
      };
      harness.scheduled.push(entry);
      return entry.cancel;
    },
    now: () => harness.nowMs,
  };
  harness.session = new VoiceSession(deps, {
    submit: (text) => void harness.submitted.push(text),
    onFrame: (chunk) => void harness.frames.push(chunk),
    onChange: (state) => void harness.statuses.push(state.status),
  });
  harness.emitFrame = (bytes: number) => emitChunk?.(new ArrayBuffer(bytes));
  return harness;
}

function begin(harness: SessionHarness, slotKey = 'speech:0:1000', deadline = 175_000): void {
  harness.session.begin({ slotKey, deadlineAtMs: deadline });
}

async function captureLive(harness: SessionHarness): Promise<void> {
  begin(harness);
  await Promise.resolve(); // flush the requestMic promise
}

describe('VoiceSession', () => {
  it('requests the mic and moves to recording once capture is live', async () => {
    const harness = makeSession();
    begin(harness);
    expect(harness.statuses[0]).toBe('requesting');
    await Promise.resolve();
    expect(harness.statuses[harness.statuses.length - 1]).toBe('recording');
    expect(harness.recognizer.starts).toEqual([0]);
  });

  it('joins finalized segments and keeps the trailing interim apart', async () => {
    const harness = makeSession();
    await captureLive(harness);
    harness.recognizer.emitResult([{ isFinal: true, transcript: '我是预言家，' }]);
    harness.recognizer.emitResult([{ isFinal: false, transcript: '昨晚查验' }]);
    expect(harness.session.current().finalText).toBe('我是预言家，');
    expect(harness.session.current().interimText).toBe('昨晚查验');
    // The interim finalizes: it lands in finalText, the interim clears.
    harness.recognizer.emitResult([{ isFinal: true, transcript: '昨晚查验' }]);
    expect(harness.session.current().finalText).toBe('我是预言家，昨晚查验');
    expect(harness.session.current().interimText).toBe('');
  });

  it('auto-submits the joined final transcript one second before the deadline', async () => {
    const harness = makeSession();
    begin(harness, 'speech:0:1000', 175_000);
    expect(harness.scheduled[0]?.delay).toBe(175_000 - SUBMIT_MARGIN_MS - harness.nowMs);
    await captureLive(harness);
    harness.recognizer.emitResult([{ isFinal: true, transcript: '过' }]);
    harness.recognizer.emitResult([{ isFinal: false, transcript: '一下' }]);
    harness.scheduled[0]?.fire();
    expect(harness.submitted).toEqual(['过一下']);
    expect(harness.session.current().status).toBe('submitted');
    // Submitted: capture released, late frames and results drop.
    expect(harness.streamStops).toBe(1);
    expect(harness.recorderStops).toBe(1);
    harness.emitFrame(64);
    expect(harness.frames).toHaveLength(0);
    // Late recognition results drop after submit — finalText stays as sent.
    harness.recognizer.emitResult([{ isFinal: true, transcript: '迟到' }]);
    expect(harness.session.current().finalText).toBe('过');
  });

  it('clips the submitted transcript to the server speech cap', async () => {
    const harness = makeSession();
    await captureLive(harness);
    const long = '长'.repeat(MAX_SPEECH_LENGTH + 50);
    harness.recognizer.emitResult([{ isFinal: true, transcript: long }]);
    harness.scheduled[0]?.fire();
    expect(harness.submitted[0]).toHaveLength(MAX_SPEECH_LENGTH);
  });

  it('never submits silence — the slot ends as 未发言 instead', async () => {
    const harness = makeSession();
    await captureLive(harness);
    harness.scheduled[0]?.fire();
    expect(harness.submitted).toEqual([]);
    harness.session.end();
    expect(harness.session.current()).toMatchObject({ status: 'silent', finalText: '' });
  });

  it('maps a rejected mic to 语音不可用 and stops the recognizer', async () => {
    const harness = makeSession({ mic: 'denied' });
    begin(harness);
    await Promise.resolve();
    expect(harness.session.current().status).toBe('unavailable');
    expect(harness.session.current().error).toBe('麦克风权限被拒绝');
    harness.session.end();
    // 语音不可用 survives the slot end — the mic problem is the real news.
    expect(harness.session.current().status).toBe('unavailable');
  });

  it('keeps relaying frames with no recognizer — the server fallback is authoritative', async () => {
    const harness = makeSession({ recognizer: null });
    await captureLive(harness);
    expect(harness.session.current().status).toBe('unsupported');
    harness.emitFrame(256);
    expect(harness.frames).toHaveLength(1);
    harness.session.end();
    expect(harness.session.current().status).toBe('silent');
  });

  it('releases the mic on slot end and starts a fresh session on the next slot', async () => {
    const harness = makeSession();
    await captureLive(harness);
    harness.session.end();
    expect(harness.streamStops).toBe(1);
    expect(harness.session.current().status).toBe('silent');

    begin(harness, 'speech:1:1002'); // a different slot key
    await Promise.resolve();
    expect(harness.session.current().status).toBe('recording');
    harness.emitFrame(32);
    expect(harness.frames).toHaveLength(1);
  });

  it('releasing a late mic grant costs nothing when the slot already ended', async () => {
    const harness = makeSession();
    begin(harness);
    harness.session.end(); // the permission prompt is still open
    await Promise.resolve();
    expect(harness.session.current().status).toBe('silent');
  });

  it('releases the orphan when a stale grant lands on a newer slot', async () => {
    // Slot A's permission prompt is open when A ends and B begins; A's grant
    // must release instead of adopting over B's slot.
    const harness = makeSession({ deferMic: true });
    begin(harness, 'speech:0:1000');
    harness.session.end();
    begin(harness, 'speech:1:1002');
    expect(harness.grantsPending()).toBe(2);

    harness.grantMic(0); // A's grant resolves after B began
    await Promise.resolve();
    expect(harness.streamStops).toBe(1); // the orphan stream released
    expect(harness.recorderStreams).toHaveLength(0); // never recorded
    expect(harness.frames).toHaveLength(0);

    harness.grantMic(1); // B's grant is the live slot's
    await Promise.resolve();
    expect(harness.session.current().status).toBe('recording');
    expect(harness.recorderStreams).toHaveLength(1); // exactly one adopted stream
    expect(harness.recognizer.starts).toEqual([0]); // captions started once, for B
    harness.emitFrame(32);
    expect(harness.frames).toHaveLength(1); // exactly one stream relays frames

    harness.session.end();
    expect(harness.streamStops).toBe(2); // the adopted stream releases with the slot
  });

  it('a stale grant rejection does not clobber the live slot', async () => {
    const harness = makeSession({ deferMic: true });
    begin(harness, 'speech:0:1000');
    harness.session.end();
    begin(harness, 'speech:1:1002');
    harness.rejectMic(0); // A's prompt ends in denial after B began
    await Promise.resolve();
    expect(harness.session.current().status).toBe('requesting'); // B still waiting
    harness.grantMic(1);
    await Promise.resolve();
    expect(harness.session.current().status).toBe('recording');
    expect(harness.recognizer.starts).toEqual([0]);
  });

  it('ignores a begin for the slot it is already capturing', async () => {
    const harness = makeSession();
    begin(harness, 'speech:0:1000');
    await Promise.resolve();
    const statusesBefore = harness.statuses.length;
    begin(harness, 'speech:0:1000');
    expect(harness.statuses.length).toBe(statusesBefore);
    expect(harness.recognizer.starts).toHaveLength(1);
  });

  it('cancels the pending submit when the slot ends first', () => {
    const harness = makeSession();
    begin(harness);
    harness.session.end();
    expect(() => harness.scheduled[0]?.fire()).not.toThrow();
    expect(harness.submitted).toEqual([]);
  });

  it('restarts a recognizer that ended on its own mid-slot', async () => {
    const harness = makeSession();
    await captureLive(harness);
    const startsBefore = harness.recognizer.starts.length;
    harness.recognizer.emitEnd();
    expect(harness.recognizer.starts.length).toBe(startsBefore + 1);
  });
});
