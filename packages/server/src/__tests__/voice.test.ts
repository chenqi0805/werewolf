import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Seat } from '@werewolf/engine';
import {
  FALLBACK_DEADLINE_MS,
  MAX_BUFFER_BYTES,
  MAX_CHUNK_BYTES,
  OPENAI_TRANSCRIBE_URL,
  VoiceHub,
  gateVoiceFrame,
  handleVoiceFrame,
  transcribeWithOpenAI,
  type SpeechSlot,
  type SttConfig,
  type VoiceHost,
} from '../voice';
import type { RoomRegistry } from '../room';
import { fixedRoom } from './fixtures';
import { lastWords, nightKill, runSpeech, seerCheck, witchPass } from './drivers';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

class FakeSocket {
  readonly chunks: Array<{ seat: Seat; seq: number; data: ArrayBuffer }> = [];
  emit(event: 'voice:chunk', payload: { seat: Seat; seq: number; data: ArrayBuffer }): void {
    if (event !== 'voice:chunk') return;
    this.chunks.push(payload);
  }
}

class FakeHost implements VoiceHost {
  readonly sockets = new Map<string, FakeSocket[]>();
  socketsOf(code: string): FakeSocket[] {
    return this.sockets.get(code) ?? [];
  }
}

const STT: SttConfig = { provider: 'openai', apiKey: 'key', model: 'test-stt', language: 'zh-CN' };

/** A fixed-deck room with all 12 seats filled, ready to start. */
function filledRoom(): ReturnType<typeof fixedRoom> {
  const room = fixedRoom();
  for (let i = 0; i < 12; i++) room.join();
  return room;
}

/** Night 1 with a wolf kill, then the election and the day-1 floor, up to a slot. */
function driveToSheriffSpeech(): ReturnType<typeof fixedRoom> {
  const room = filledRoom();
  room.start();
  nightKill(room, 5);
  witchPass(room);
  seerCheck(room, 1); // the last night step; the night resolves to sheriff-signup
  for (const c of [9, 10]) room.applyPlayerAction({ type: 'SHERIFF_SIGNUP', actor: c });
  room.proceed(); // close signup -> sheriff-speech
  return room;
}

/** Candidacy speeches + unanimous vote, from an open sheriff-speech phase. */
function closeElection(room: ReturnType<typeof fixedRoom>, winner: Seat): void {
  for (const c of [9, 10]) {
    room.applyPlayerAction({ type: 'SPEAK', actor: c, text: `candidacy ${c}` });
    room.proceed();
  }
  const electorate = room.state.vote?.electorate ?? [];
  for (const voter of electorate) {
    room.applyPlayerAction({ type: 'SHERIFF_VOTE', actor: voter, target: winner });
  }
}

function driveToLastWords(): ReturnType<typeof fixedRoom> {
  const room = driveToSheriffSpeech();
  closeElection(room, 9); // ends at dawn-announce
  room.proceed(); // dawn-announce -> last-words
  return room;
}

function driveToSpeech(): ReturnType<typeof fixedRoom> {
  const room = driveToLastWords();
  lastWords(room, 5); // -> speech, direction unset
  const sheriff = Object.values(room.state.players).find((p) => p.hasBadge && p.alive);
  room.applyPlayerAction({
    type: 'SET_SPEECH_DIRECTION',
    actor: sheriff?.seat ?? 9,
    direction: 'cw',
  });
  return room;
}

function driveToPkSpeech(): ReturnType<typeof fixedRoom> {
  const room = driveToSpeech();
  runSpeech(room);
  // 5-5 tie between seats 6 and 7 (the sheriff's ballot weighs 1.5, so 9 abstains).
  for (const voter of [1, 2, 3, 4, 6]) {
    room.applyPlayerAction({ type: 'EXILE_VOTE', actor: voter, target: 7 });
  }
  for (const voter of [7, 8, 10, 11, 12]) {
    room.applyPlayerAction({ type: 'EXILE_VOTE', actor: voter, target: 6 });
  }
  room.applyPlayerAction({ type: 'EXILE_VOTE', actor: 9, target: null });
  return room;
}

describe('currentSpeechSlot', () => {
  it('has no slot during the night', () => {
    const room = filledRoom();
    room.start();
    expect(room.state.phase).toBe('night');
    expect(room.currentSpeechSlot()).toBeNull();
  });

  it('has no slot while sheriff signup is open with no candidates', () => {
    const room = filledRoom();
    room.start();
    nightKill(room, 5);
    witchPass(room);
    seerCheck(room, 1); // -> sheriff-signup, nobody signed up yet
    expect(room.state.phase).toBe('sheriff-signup');
    expect(room.currentSpeechSlot()).toBeNull();
  });

  it('follows the sheriff candidacy queue', () => {
    const room = driveToSheriffSpeech();
    expect(room.state.phase).toBe('sheriff-speech');
    const slot = room.currentSpeechSlot();
    expect(slot).toMatchObject({ seat: 9, context: 'sheriff-speech' });
    expect(slot?.key.startsWith('sheriff-speech@')).toBe(true);
  });

  it('has no slot between the seer window and the election', () => {
    const room = filledRoom();
    room.start();
    nightKill(room, 5);
    witchPass(room);
    expect(room.state.phase).toBe('night');
    expect(room.currentSpeechSlot()).toBeNull();
    seerCheck(room, 1); // the night resolves to sheriff-signup
    expect(room.state.phase).toBe('sheriff-signup');
    expect(room.currentSpeechSlot()).toBeNull();
  });

  it('gives the night victim the last-words slot', () => {
    const room = driveToLastWords();
    expect(room.state.phase).toBe('last-words');
    expect(room.currentSpeechSlot()).toMatchObject({ seat: 5, context: 'last-words' });
  });

  it('accepts nobody in the speech phase before the direction is set', () => {
    const room = driveToLastWords();
    lastWords(room, 5);
    expect(room.state.phase).toBe('speech');
    expect(room.state.speech?.order).toBeNull();
    expect(room.currentSpeechSlot()).toBeNull();
  });

  it('follows the running order once the direction is set', () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const order = room.state.speech?.order ?? [];
    expect(slot).toMatchObject({ seat: order[0], context: 'speech' });
  });

  it('follows the pk queue on an exile tie', () => {
    const room = driveToPkSpeech();
    expect(room.state.phase).toBe('pk-speech');
    const pk = room.state.pk;
    const slot = room.currentSpeechSlot();
    expect(slot?.context).toBe('pk-speech');
    expect(slot?.seat).toBe(pk?.tied[pk.cursor]);
    expect(pk?.tied).toEqual(expect.arrayContaining([6, 7]));
  });
});

describe('gateVoiceFrame', () => {
  it('accepts a frame from the current speaker', () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const verdict = gateVoiceFrame(slot, slot?.seat ?? null, bytes('hello'));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(new TextDecoder().decode(verdict.bytes)).toBe('hello');
      expect(verdict.wire).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(new Uint8Array(verdict.wire))).toBe('hello');
      expect(verdict.slot).toBe(slot);
    }
  });

  it('drops a frame from a non-speaker', () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const other = (slot?.seat ?? 1) === 1 ? 2 : 1;
    expect(gateVoiceFrame(slot, other, bytes('hello'))).toMatchObject({
      ok: false,
      reason: 'NOT_YOUR_TURN',
    });
  });

  it('drops a frame from a spectator (no seat)', () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    expect(gateVoiceFrame(slot, null, bytes('hello'))).toMatchObject({
      ok: false,
      reason: 'NO_SEAT',
    });
  });

  it('drops frames outside speech contexts', () => {
    const room = filledRoom();
    room.start(); // night
    expect(gateVoiceFrame(null, 1, bytes('hello'))).toMatchObject({
      ok: false,
      reason: 'WRONG_PHASE',
    });
  });

  it('drops frames in the speech phase while the direction is unset', () => {
    const room = driveToLastWords();
    lastWords(room, 5);
    expect(gateVoiceFrame(room.currentSpeechSlot(), 1, bytes('hello'))).toMatchObject({
      ok: false,
      reason: 'WRONG_PHASE',
    });
  });

  it('drops an oversize chunk and accepts one at exactly the cap', () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const seat = slot?.seat ?? null;
    expect(gateVoiceFrame(slot, seat, new ArrayBuffer(MAX_CHUNK_BYTES + 1))).toMatchObject({
      ok: false,
      reason: 'CHUNK_TOO_LARGE',
    });
    expect(gateVoiceFrame(slot, seat, new ArrayBuffer(MAX_CHUNK_BYTES)).ok).toBe(true);
  });

  it('drops empty and non-binary chunks', () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const seat = slot?.seat ?? null;
    expect(gateVoiceFrame(slot, seat, new ArrayBuffer(0))).toMatchObject({ reason: 'BAD_CHUNK' });
    expect(gateVoiceFrame(slot, seat, 'hello')).toMatchObject({ reason: 'BAD_CHUNK' });
    expect(gateVoiceFrame(slot, seat, { length: 5 })).toMatchObject({ reason: 'BAD_CHUNK' });
  });

  it('normalizes a Buffer (typed view) frame onto a standalone wire buffer', () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const buf = Buffer.from('buffer frame');
    const verdict = gateVoiceFrame(slot, slot?.seat ?? null, buf);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(new TextDecoder().decode(verdict.wire)).toBe('buffer frame');
      // The wire copy never aliases the caller's memory.
      expect(verdict.wire).not.toBe(buf.buffer);
    }
  });
});

describe('VoiceHub', () => {
  const slotAt = (room: ReturnType<typeof fixedRoom>): SpeechSlot => {
    const slot = room.currentSpeechSlot();
    if (!slot) throw new Error(`no speech slot in phase ${room.state.phase}`);
    return slot;
  };

  it('stamps relay sequences per slot and resets on slot change', () => {
    const hub = new VoiceHub(new FakeHost(), { stt: STT });
    const room = driveToSpeech();
    const slot = slotAt(room);
    expect(hub.noteFrame('TEST', slot, bytes('a'))).toBe(1);
    expect(hub.noteFrame('TEST', slot, bytes('b'))).toBe(2);
    // Same context, different slot identity -> fresh sequence.
    const next: SpeechSlot = { ...slot, key: `${slot.key}#next` };
    expect(hub.noteFrame('TEST', next, bytes('c'))).toBe(1);
  });

  it('never buffers when the STT fallback is unarmed', () => {
    const hub = new VoiceHub(new FakeHost());
    const room = driveToSpeech();
    const slot = slotAt(room);
    expect(hub.fallbackArmed()).toBe(false);
    hub.noteFrame('TEST', slot, bytes('a'));
    expect(hub.takeBuffer('TEST', slot.key)).toBeNull();
  });

  it('caps the per-slot buffer at 2 MB and discards the overflow', () => {
    const hub = new VoiceHub(new FakeHost(), { stt: STT });
    const room = driveToSpeech();
    const slot = slotAt(room);
    const chunk = new Uint8Array(MAX_CHUNK_BYTES);
    for (let i = 0; i < MAX_BUFFER_BYTES / MAX_CHUNK_BYTES + 1; i++) {
      hub.noteFrame('TEST', slot, chunk);
    }
    const taken = hub.takeBuffer('TEST', slot.key);
    expect(taken?.byteLength).toBe(MAX_BUFFER_BYTES);
  });

  it('consumes the buffer on take', () => {
    const hub = new VoiceHub(new FakeHost(), { stt: STT });
    const room = driveToSpeech();
    const slot = slotAt(room);
    hub.noteFrame('TEST', slot, bytes('audio'));
    expect(hub.takeBuffer('TEST', slot.key)).toBeTruthy();
    expect(hub.takeBuffer('TEST', slot.key)).toBeNull();
  });

  it('ignores and clears a buffer that belongs to an older slot', () => {
    const hub = new VoiceHub(new FakeHost(), { stt: STT });
    const room = driveToSpeech();
    const slot = slotAt(room);
    hub.noteFrame('TEST', slot, bytes('audio'));
    // The slot moved (a client SPEAK grew the log) before expiry.
    expect(hub.takeBuffer('TEST', `${slot.key}#moved`)).toBeNull();
    expect(hub.takeBuffer('TEST', slot.key)).toBeNull();
  });

  it('drops a room buffer outright with dropRoom, leaving other rooms alone', () => {
    const hub = new VoiceHub(new FakeHost(), { stt: STT });
    const room = driveToSpeech();
    const slot = slotAt(room);
    hub.noteFrame('TEST', slot, bytes('audio'));
    hub.noteFrame('OTHER', slot, bytes('audio'));

    hub.dropRoom('TEST');
    expect(hub.takeBuffer('TEST', slot.key)).toBeNull();
    expect(hub.takeBuffer('OTHER', slot.key)).toBeTruthy();

    // Unknown room codes are a no-op.
    hub.dropRoom('MISSING');
  });

  it('returns the provider transcript', async () => {
    const hub = new VoiceHub(new FakeHost(), {
      stt: STT,
      transcribe: async () => '大家好',
    });
    expect(await hub.transcribe(bytes('audio'))).toBe('大家好');
  });

  it('swallows provider failure as null', async () => {
    const hub = new VoiceHub(new FakeHost(), {
      stt: STT,
      transcribe: async () => {
        throw new Error('provider down');
      },
    });
    expect(await hub.transcribe(bytes('audio'))).toBeNull();
  });

  it('enforces a hard deadline on a hanging provider', async () => {
    const hub = new VoiceHub(new FakeHost(), {
      stt: STT,
      fallbackTimeoutMs: 30,
      transcribe: () =>
        new Promise<string>((resolve) => {
          // Never resolves on its own — the deadline must cut it off.
          setTimeout(() => resolve('too late'), 5000);
        }),
    });
    const started = Date.now();
    expect(await hub.transcribe(bytes('audio'))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  }, 5000);

  it('skips the provider call for empty audio', async () => {
    const fn = vi.fn(async () => '大家好');
    const hub = new VoiceHub(new FakeHost(), { stt: STT, transcribe: fn });
    expect(await hub.transcribe(new Uint8Array(0))).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('defaults the fallback deadline to six seconds', () => {
    expect(FALLBACK_DEADLINE_MS).toBe(6000);
  });
});

describe('transcribeWithOpenAI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the buffer to the transcriptions endpoint and parses the text', async () => {
    const fake = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ text: '大家好' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fake);
    const text = await transcribeWithOpenAI(bytes('audio'), STT, new AbortController().signal);
    expect(text).toBe('大家好');
    expect(fake.mock.calls[0]?.[0]).toBe(OPENAI_TRANSCRIBE_URL);
    const init = fake.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('test-stt');
    // OpenAI's transcription language is ISO-639-1.
    expect(form.get('language')).toBe('zh');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 401 })),
    );
    const text = await transcribeWithOpenAI(bytes('audio'), STT, new AbortController().signal);
    expect(text).toBeNull();
  });

  it('returns null on a malformed body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const text = await transcribeWithOpenAI(bytes('audio'), STT, new AbortController().signal);
    expect(text).toBeNull();
  });
});

describe('handleVoiceFrame', () => {
  function registryOf(room: ReturnType<typeof fixedRoom>): Pick<RoomRegistry, 'get'> {
    return { get: (code: string) => (code === room.code ? room : undefined) };
  }

  function world(): {
    room: ReturnType<typeof fixedRoom>;
    hub: VoiceHub;
    sender: FakeSocket;
    listener: FakeSocket;
    slot: SpeechSlot;
  } {
    const room = driveToSpeech();
    const host = new FakeHost();
    const hub = new VoiceHub(host, { stt: STT });
    const sender = new FakeSocket();
    const listener = new FakeSocket();
    host.sockets.set(room.code, [sender, listener]);
    const slot = room.currentSpeechSlot();
    if (!slot) throw new Error(`no speech slot in phase ${room.state.phase}`);
    return { room, hub, sender, listener, slot };
  }

  it('relays to every socket but the speaker, and buffers for the fallback', () => {
    const { room, hub, sender, listener, slot } = world();
    handleVoiceFrame(hub, registryOf(room), room.code, slot.seat, sender, bytes('语音'));
    // The speaker never hears themselves.
    expect(sender.chunks).toEqual([]);
    expect(listener.chunks).toEqual([{ seat: slot.seat, seq: 1, data: expect.any(ArrayBuffer) }]);
    // The fallback buffer mirrors the gated frame.
    expect(new TextDecoder().decode(hub.takeBuffer(room.code, slot.key))).toBe('语音');
  });

  it('drops non-speaker frames end to end', () => {
    const { room, hub, sender, listener, slot } = world();
    const impostor = slot.seat === 1 ? 2 : 1;
    handleVoiceFrame(hub, registryOf(room), room.code, impostor, sender, bytes('hello'));
    expect(sender.chunks).toEqual([]);
    expect(listener.chunks).toEqual([]);
    expect(hub.takeBuffer(room.code, slot.key)).toBeNull();
  });

  it('ignores frames from unbound sockets', () => {
    const { room, hub, sender, listener } = world();
    handleVoiceFrame(hub, registryOf(room), null, 1, sender, bytes('hello'));
    handleVoiceFrame(hub, registryOf(room), room.code, null, sender, bytes('hello'));
    handleVoiceFrame(hub, registryOf(room), 'MISSING', 1, sender, bytes('hello'));
    expect(sender.chunks).toEqual([]);
    expect(listener.chunks).toEqual([]);
  });
});
