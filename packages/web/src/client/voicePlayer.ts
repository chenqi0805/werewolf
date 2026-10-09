import type { GameSocket } from './socketClient';

/** The half of a `voice:chunk` payload the player needs. */
interface VoiceChunk {
  seat: number;
  seq: number;
  data: ArrayBuffer;
}

export interface VoicePlayer {
  /** True while incoming frames are dropped instead of scheduled. */
  muted(): boolean;
  /** Muting drops live frames; audio heard before the mute is not replayed. */
  setMuted(muted: boolean): void;
  /** Stops playback and detaches from the socket — call on unmount. */
  dispose(): void;
}

/**
 * Injection seams: `now` is the playback clock, `decode` turns a chunk into a
 * buffer, `play` schedules one buffer. The defaults bind a real AudioContext;
 * tests hand in doubles and never touch Web Audio.
 */
export interface VoicePlayerDeps {
  now?: () => number;
  decode?: (data: ArrayBuffer) => Promise<AudioBuffer>;
  play?: (buffer: AudioBuffer, at: number) => void;
}

/**
 * Live playback for relayed speech: queues `voice:chunk` frames on an
 * AudioContext so consecutive chunks play back-to-back. The schedule cursor
 * advances by each buffer's duration; if decoding falls behind the clock the
 * backlog is dropped in favor of the next fresh frame — live audio beats
 * catch-up. The server already excludes the speaker's own chunks.
 */
export function createVoicePlayer(socket: GameSocket, deps: VoicePlayerDeps = {}): VoicePlayer {
  // The AudioContext is built lazily: with every dep injected (tests) no Web
  // Audio object is ever constructed.
  let ctx: AudioContext | null = null;
  const ensureCtx = (): AudioContext => {
    if (ctx === null) ctx = new AudioContext();
    return ctx;
  };
  const now = deps.now ?? (() => ensureCtx().currentTime);
  const decode = deps.decode ?? ((data: ArrayBuffer) => ensureCtx().decodeAudioData(data));
  const play =
    deps.play ??
    ((buffer: AudioBuffer, at: number) => {
      const c = ensureCtx();
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(c.destination);
      source.start(at);
    });

  let muted = false;
  let disposed = false;
  let playAt = now();
  // Serializes decode+schedule so buffers always reach `play` in arrival
  // order even when individual decodes resolve out of order.
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (chunk: VoiceChunk): void => {
    pending = pending
      .then(() => (disposed || muted ? undefined : decode(chunk.data)))
      .then((buffer) => {
        if (buffer === undefined || disposed || muted) return;
        // Browsers may leave a fresh AudioContext suspended until the page
        // has had a gesture; every click before speech counts.
        if (ctx !== null && ctx.state === 'suspended') void ctx.resume();
        const t = now();
        if (playAt < t) playAt = t; // fell behind: drop the backlog
        play(buffer, playAt);
        playAt += buffer.duration;
      })
      .catch(() => {
        // Undecodable frame (truncated tail, wrong codec) — skip it; the
        // transcript is the record of truth, not the audio.
      });
  };

  socket.on('voice:chunk', enqueue);

  return {
    muted: () => muted,
    setMuted(next) {
      muted = next;
    },
    dispose() {
      disposed = true;
      socket.off('voice:chunk', enqueue);
      if (ctx !== null) void ctx.close();
    },
  };
}
