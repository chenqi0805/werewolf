import { describe, expect, it, vi } from 'vitest';

import type { GameSocket } from './socketClient';
import { createVoicePlayer, type VoicePlayerDeps } from './voicePlayer';

interface Chunk {
  seat: number;
  seq: number;
  data: ArrayBuffer;
}

/** Hand-rolled socket double capturing the `voice:chunk` handler. */
function fakeSocket() {
  const handlers = new Set<(chunk: Chunk) => void>();
  return {
    on: vi.fn((event: string, handler: (chunk: Chunk) => void) => {
      if (event === 'voice:chunk') handlers.add(handler);
    }),
    off: vi.fn((event: string, handler: (chunk: Chunk) => void) => {
      handlers.delete(handler);
    }),
    emit: vi.fn(),
    deliver: (chunk: Chunk) => handlers.forEach((handler) => handler(chunk)),
    handlerCount: () => handlers.size,
  };
}

const fakeBuffer = (duration: number): AudioBuffer => ({ duration }) as unknown as AudioBuffer;

/** Lets tests release queued decodes one at a time, in any order. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createVoicePlayer', () => {
  it('schedules consecutive chunks back-to-back in arrival order', async () => {
    const socket = fakeSocket();
    const played: Array<{ at: number; duration: number }> = [];
    const clock = 100;
    const deps: VoicePlayerDeps = {
      now: () => clock,
      decode: (data) => Promise.resolve(fakeBuffer(data.byteLength)),
      play: (buffer, at) => played.push({ at, duration: buffer.duration }),
    };
    const player = createVoicePlayer(socket as unknown as GameSocket, deps);

    socket.deliver({ seat: 4, seq: 0, data: new ArrayBuffer(3) });
    socket.deliver({ seat: 4, seq: 1, data: new ArrayBuffer(2) });
    socket.deliver({ seat: 4, seq: 2, data: new ArrayBuffer(5) });
    await flush();

    expect(played).toEqual([
      { at: 100, duration: 3 },
      { at: 103, duration: 2 },
      { at: 105, duration: 5 },
    ]);
    player.dispose();
  });

  it('keeps arrival order even when decodes resolve out of order', async () => {
    const socket = fakeSocket();
    const played: number[] = [];
    const first = deferred<AudioBuffer>();
    const second = deferred<AudioBuffer>();
    const clock = 0;
    const player = createVoicePlayer(socket as unknown as GameSocket, {
      now: () => clock,
      decode: (data) => (data.byteLength === 1 ? first.promise : second.promise),
      play: (buffer, at) => played.push(at),
    });

    socket.deliver({ seat: 4, seq: 0, data: new ArrayBuffer(1) });
    socket.deliver({ seat: 4, seq: 1, data: new ArrayBuffer(2) });
    second.resolve(fakeBuffer(0.25)); // second chunk decodes first
    await flush();
    first.resolve(fakeBuffer(0.5));
    await flush();

    // The slow first chunk still schedules before the second.
    expect(played).toEqual([0, 0.5]);
    player.dispose();
  });

  it('drops frames while muted and resumes with fresh audio after unmute', async () => {
    const socket = fakeSocket();
    const played: number[] = [];
    const clock = 0;
    const player = createVoicePlayer(socket as unknown as GameSocket, {
      now: () => clock,
      decode: (data) => Promise.resolve(fakeBuffer(data.byteLength)),
      play: (buffer, at) => played.push(at),
    });

    player.setMuted(true);
    expect(player.muted()).toBe(true);
    socket.deliver({ seat: 4, seq: 0, data: new ArrayBuffer(1) });
    await flush();
    expect(played).toEqual([]);

    player.setMuted(false);
    socket.deliver({ seat: 4, seq: 1, data: new ArrayBuffer(2) });
    await flush();
    expect(played).toEqual([0]);
    player.dispose();
  });

  it('drops the schedule backlog instead of playing stale audio', async () => {
    const socket = fakeSocket();
    const played: number[] = [];
    let clock = 0;
    const player = createVoicePlayer(socket as unknown as GameSocket, {
      now: () => clock,
      decode: (data) => Promise.resolve(fakeBuffer(data.byteLength)),
      play: (buffer, at) => played.push(at),
    });

    socket.deliver({ seat: 4, seq: 0, data: new ArrayBuffer(10) });
    await flush();
    clock = 500; // playback stalled for seconds — the queue is stale
    socket.deliver({ seat: 4, seq: 1, data: new ArrayBuffer(2) });
    await flush();

    expect(played).toEqual([0, 500]);
    player.dispose();
  });

  it('skips undecodable frames without breaking the queue', async () => {
    const socket = fakeSocket();
    const played: number[] = [];
    const clock = 0;
    const player = createVoicePlayer(socket as unknown as GameSocket, {
      now: () => clock,
      decode: (data) =>
        data.byteLength === 1
          ? Promise.reject(new Error('undecodable'))
          : Promise.resolve(fakeBuffer(data.byteLength)),
      play: (buffer, at) => played.push(at),
    });

    socket.deliver({ seat: 4, seq: 0, data: new ArrayBuffer(1) });
    socket.deliver({ seat: 4, seq: 1, data: new ArrayBuffer(2) });
    await flush();

    expect(played).toEqual([0]);
    player.dispose();
  });

  it('detaches its handler on dispose', () => {
    const socket = fakeSocket();
    const player = createVoicePlayer(socket as unknown as GameSocket, {
      now: () => 0,
      decode: (data) => Promise.resolve(fakeBuffer(data.byteLength)),
      play: () => undefined,
    });
    expect(socket.handlerCount()).toBe(1);
    player.dispose();
    expect(socket.handlerCount()).toBe(0);
  });
});
