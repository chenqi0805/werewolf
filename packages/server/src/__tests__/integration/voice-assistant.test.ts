import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientToServerEvents, ServerToClientEvents } from '../../index';
import type { StrategyReply } from '../../assistant';
import type { Seat } from '@werewolf/engine';
import type { Socket } from 'socket.io-client';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  scriptTimers,
  startRoom,
  startServer,
  stopServer,
  sweepAllPayloads,
  waitFor,
  type Rig,
} from './helpers';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const rigs: Rig[] = [];

async function freshRig(...args: Parameters<typeof startServer>): Promise<Rig> {
  const rig = await startServer(...args);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

/** A full 12-seat table with no client actions — compact clocks run the game. */
async function seatTwelve(rig: Rig): Promise<void> {
  const creator = await connect(rig);
  const { roomCode } = await createRoom(creator.client);
  const joiners = await connectAll(rig, 11);
  for (const j of joiners) await joinRoom(j.client, roomCode);
  await startRoom(creator.client);
}

/** The client whose own view says the current speech slot is theirs. */
function currentSpeakerClient(rig: Rig): { client: Client; seat: Seat } | null {
  for (let i = 0; i < rig.clients.length; i++) {
    const rec = rig.recs[i];
    const view = rec?.latest;
    if (!view || view.phase !== 'speech' || view.step.kind !== 'speech') continue;
    if (view.step.order === null) continue;
    const client = rig.clients[i];
    if (!client) continue;
    const slotSeat = view.step.order[view.step.cursor];
    if (slotSeat !== undefined && slotSeat === view.you.seat) return { client, seat: slotSeat };
  }
  return null;
}

function askStrategy(client: Client): Promise<StrategyReply | { error: string }> {
  return new Promise((resolve) => client.emit('assistant:strategy', resolve));
}

/**
 * The first speaker says their piece so later speakers have history — the
 * assistant refuses to advise before anyone has spoken (NO_HISTORY). The
 * cursor only advances at timer expiry (PROCEED is server-injected), so the
 * assistant tests run a short speech clock and wait out the first slot.
 */
async function seedHistory(rig: Rig): Promise<void> {
  await waitFor(() => currentSpeakerClient(rig) !== null, 10000);
  const first = currentSpeakerClient(rig);
  first?.client.emit('game:action', { type: 'SPEAK', actor: first.seat, text: '第一段发言' });
  await waitFor(() => {
    const second = currentSpeakerClient(rig);
    return second !== null && second.seat !== first?.seat;
  }, 15000);
}

describe('voice relay and the STT fallback over real sockets', () => {
  it('relays live frames, then transcribes the buffer into the slot speech at expiry', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ text: '大家好,我是6号' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const rig = await freshRig(
      { ...scriptTimers(), speech: 2500 },
      {
        voice: {
          stt: {
            provider: 'openai',
            apiKey: 'sk-test',
            model: 'gpt-4o-mini-transcribe',
            language: 'zh-CN',
          },
        },
      },
    );
    await seatTwelve(rig);

    // Zero client actions: the night abstains through, the election voids, and
    // the day-1 floor opens with the default order.
    await waitFor(() => currentSpeakerClient(rig) !== null, 10000);
    const speaker = currentSpeakerClient(rig);
    expect(speaker, 'a speech slot should be occupied').not.toBeNull();

    // The current speaker relays a few raw frames; every other socket hears them.
    const frame = new TextEncoder().encode('fake-pcm-audio').buffer as ArrayBuffer;
    for (let i = 0; i < 3; i++) speaker?.client.emit('voice:frame', frame);
    await waitFor(() => rig.recs.some((r) => r.voiceChunks.length >= 3));

    // At slot expiry the buffered audio becomes the slot's speech — no client
    // SPEAK was ever sent.
    await waitFor(
      () =>
        rig.recs.every((r) =>
          r.events.some((e) => e.type === 'SPEECH_MADE' && e.text === '大家好,我是6号'),
        ),
      12000,
    );
    expect(calls[0]?.includes('/v1/audio/transcriptions')).toBe(true);

    // The deferral is bounded: the mocked STT resolves immediately, so the floor
    // must move on well inside the 6 s ceiling.
    await waitFor(() => {
      for (const r of rig.recs) {
        const view = r.latest;
        if (!view) continue;
        if (view.phase !== 'speech' || view.step.kind !== 'speech') return true;
        if (view.step.cursor !== 0) return true;
      }
      return false;
    }, 4000);

    // The speaker's own socket never hears itself.
    const speakerRec = rig.recs[rig.clients.indexOf(speaker?.client as Client)];
    expect(speakerRec?.voiceChunks ?? []).toEqual([]);

    sweepAllPayloads(rig);
  }, 30000);

  it('passes the slot silently when STT is armed but no audio was buffered', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ text: 'never' }), { status: 200 });
      }),
    );
    const rig = await freshRig(
      { ...scriptTimers(), speech: 120 },
      {
        voice: {
          stt: {
            provider: 'openai',
            apiKey: 'sk-test',
            model: 'gpt-4o-mini-transcribe',
            language: 'zh-CN',
          },
        },
      },
    );
    await seatTwelve(rig);

    // Nobody sends frames or speech: every slot expires empty and the round
    // moves on — the game never stalls on the fallback.
    await waitFor(
      () => rig.recs.some((r) => r.latest !== null && r.latest.phase !== 'speech'),
      20000,
    );
    for (const r of rig.recs) {
      expect(r.events.some((e) => e.type === 'SPEECH_MADE')).toBe(false);
    }
    expect(calls).toEqual([]);
    sweepAllPayloads(rig);
  }, 30000);

  it('passes slots silently with no STT configured at all', async () => {
    const rig = await freshRig(); // scriptTimers: every speech slot is 40 ms
    await seatTwelve(rig);

    await waitFor(
      () => rig.recs.some((r) => r.latest !== null && r.latest.phase !== 'speech'),
      20000,
    );
    for (const r of rig.recs) {
      expect(r.events.some((e) => e.type === 'SPEECH_MADE')).toBe(false);
    }
    sweepAllPayloads(rig);
  }, 30000);
});

describe('assistant:strategy over real sockets', () => {
  const REPLY = {
    lines: ['先报身份,再给方向'],
    reasoning: '场上信息很少,先立身份。',
    warnings: ['狼人可能贴脸'],
  };

  it('acks the current speaker with the provider reply and refuses everyone else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(REPLY) }] }),
            { status: 200 },
          ),
      ),
    );
    const rig = await freshRig(
      { ...scriptTimers(), speech: 1500 },
      { assistant: { anthropicApiKey: 'sk-cloud' } },
    );
    await seatTwelve(rig);
    await seedHistory(rig);
    const speaker = currentSpeakerClient(rig);
    expect(speaker).not.toBeNull();

    const ack = await askStrategy(speaker?.client as Client);
    expect(ack).toEqual(REPLY);
    const speakerRec = rig.recs.find((r) => r.latest?.you.seat === speaker?.seat);
    speakerRec?.acks.push(ack);

    // A non-speaker is refused by the same gate that owns speech slots.
    const listener = rig.clients.find((c) => c !== speaker?.client);
    expect(listener).toBeDefined();
    const foreignAck = await askStrategy(listener as Client);
    expect(foreignAck).toEqual({ error: 'NOT_YOUR_TURN' });

    sweepAllPayloads(rig);
  }, 30000);

  it('rate limits to three asks per speech slot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(REPLY) }] }),
            { status: 200 },
          ),
      ),
    );
    const rig = await freshRig(
      { ...scriptTimers(), speech: 1500 },
      { assistant: { anthropicApiKey: 'sk-cloud' } },
    );
    await seatTwelve(rig);
    await seedHistory(rig);
    const speaker = currentSpeakerClient(rig);
    expect(speaker).not.toBeNull();

    for (let i = 0; i < 3; i++) {
      const ack = await askStrategy(speaker?.client as Client);
      expect(ack).toEqual(REPLY);
    }
    const fourth = await askStrategy(speaker?.client as Client);
    expect(fourth).toEqual({ error: 'RATE_LIMITED' });
  }, 30000);

  it('acks ASSISTANT_UNAVAILABLE with no provider configured', async () => {
    const rig = await freshRig({ ...scriptTimers(), speech: 8000 });
    await seatTwelve(rig);
    await waitFor(() => currentSpeakerClient(rig) !== null, 10000);
    const speaker = currentSpeakerClient(rig);
    expect(speaker).not.toBeNull();

    const ack = await askStrategy(speaker?.client as Client);
    expect(ack).toEqual({ error: 'ASSISTANT_UNAVAILABLE' });
  }, 30000);
});
