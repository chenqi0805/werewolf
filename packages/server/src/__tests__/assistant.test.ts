import { describe, expect, it, vi } from 'vitest';
import type { Seat } from '@werewolf/engine';
import {
  attachAssistant,
  buildStrategyPrompt,
  parseStrategyReply,
  resolveAssistantProvider,
  speechRecordsOf,
  stripReasoningTrace,
  validateStrategyReply,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_MODEL,
  type AssistantAck,
  type AssistantServer,
  type AssistantSocket,
  type StrategyReply,
} from '../assistant';
import { viewFor } from '../view';
import type { SpeechSlot } from '../voice';
import type { Room, RoomRegistry } from '../room';
import { fixedRoom } from './fixtures';
import { lastWords, nightKill, runSpeech, seerCheck, unanimousExile, witchPass } from './drivers';

const VALID: StrategyReply = {
  lines: ['第一条发言要点', '第二条发言要点'],
  reasoning: '策略逻辑说明',
  warnings: ['注意狼人冲锋'],
};

const VALID_JSON = JSON.stringify(VALID);
type FetchInput = Parameters<typeof fetch>[0];

class FakeAssistantServer implements AssistantServer {
  private connectionHandler: ((socket: AssistantSocket) => void) | null = null;
  on(_event: 'connection', handler: (socket: AssistantSocket) => void): void {
    this.connectionHandler = handler;
  }
  connect(socket: AssistantSocket): void {
    this.connectionHandler?.(socket);
  }
}

class FakeAssistantSocket implements AssistantSocket {
  data: { roomCode: string | null; seat: Seat | null } = { roomCode: null, seat: null };
  private ackHandler: ((ack: AssistantAck) => void) | null = null;
  on(_event: 'assistant:strategy', handler: (ack: AssistantAck) => void): void {
    this.ackHandler = handler;
  }
  ask(): Promise<StrategyReply | { error: string }> {
    return new Promise((resolve) => {
      this.ackHandler?.((resp) => resolve(resp));
    });
  }
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function anthropicResponse(content: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text: content }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Seat a fake socket into a room (the gateway's socket.data binding). */
function bind(socket: FakeAssistantSocket, code: string | null, seat: Seat | null): void {
  socket.data = { roomCode: code, seat };
}

function registryOf(room: Room): Pick<RoomRegistry, 'get'> {
  return { get: (code: string) => (code === room.code ? room : undefined) };
}

/** Night 1 + election + day-1 floor, speech slots open (day 1). */
function driveToSpeech(): Room {
  const room = fixedRoom();
  for (let i = 0; i < 12; i++) room.join();
  room.start();
  nightKill(room, 5);
  witchPass(room);
  seerCheck(room, 1); // the seer learns seat 1 is a wolf
  for (const c of [9, 10]) room.applyPlayerAction({ type: 'SHERIFF_SIGNUP', actor: c });
  room.proceed(); // close signup -> sheriff-speech
  for (const c of [9, 10]) {
    room.applyPlayerAction({ type: 'SPEAK', actor: c, text: `candidacy ${c}` });
    room.proceed();
  }
  const electorate = room.state.vote?.electorate ?? [];
  for (const voter of electorate) {
    room.applyPlayerAction({ type: 'SHERIFF_VOTE', actor: voter, target: 9 });
  }
  room.proceed(); // dawn-announce -> last-words
  lastWords(room, 5);
  const sheriff = Object.values(room.state.players).find((p) => p.hasBadge && p.alive);
  room.applyPlayerAction({
    type: 'SET_SPEECH_DIRECTION',
    actor: sheriff?.seat ?? 9,
    direction: 'cw',
  });
  return room;
}

/** Day 1 completes (the idiot is exiled and survives) and day 2 reopens the floor. */
function driveToSpeechDay2(): { room: Room; day1Order: Seat[]; day2First: Seat } {
  const room = driveToSpeech();
  const day1Order = room.state.speech?.order ?? [];
  runSpeech(room);
  unanimousExile(room, 12); // the idiot flips and survives -> night 2
  nightKill(room, 6);
  witchPass(room);
  seerCheck(room, 2);
  // Night-2 deaths get no last words (nightDeathLastWords: night1-only) — the
  // dawn proceed reopens the day-2 floor directly.
  room.proceed(); // dawn-announce -> speech
  if (room.state.speech?.order === null) {
    const sheriff = Object.values(room.state.players).find((p) => p.hasBadge && p.alive);
    room.applyPlayerAction({
      type: 'SET_SPEECH_DIRECTION',
      actor: sheriff?.seat ?? 9,
      direction: 'cw',
    });
  }
  const speech = room.state.speech;
  if (!speech?.order) throw new Error('test setup: no speech order');
  const day2First = speech.order[speech.cursor ?? 0];
  if (day2First === undefined) throw new Error('test setup: empty speech order');
  room.applyPlayerAction({ type: 'SPEAK', actor: day2First, text: 'day2 speech' });
  return { room, day1Order, day2First };
}

/** The current speech slot, or the test setup is broken. */
function slotOf(room: Room): SpeechSlot {
  const slot = room.currentSpeechSlot();
  if (slot === null) throw new Error('test setup: no speech slot');
  return slot;
}

describe('resolveAssistantProvider', () => {
  it('prefers a configured OpenAI-compatible endpoint over the cloud', () => {
    const p = resolveAssistantProvider({
      baseUrl: 'http://localhost:11434/v1/',
      anthropicApiKey: 'sk-cloud',
    });
    expect(p).toMatchObject({
      kind: 'openai-compatible',
      url: 'http://localhost:11434/v1/chat/completions',
      model: DEFAULT_LOCAL_MODEL,
      apiKey: null,
    });
  });

  it('carries an optional local endpoint key and a custom model', () => {
    const p = resolveAssistantProvider({
      baseUrl: 'http://vllm:8000/v1',
      model: 'Qwen/Qwen3-8B',
      apiKey: 'llm-key',
    });
    expect(p).toMatchObject({
      kind: 'openai-compatible',
      url: 'http://vllm:8000/v1/chat/completions',
      model: 'Qwen/Qwen3-8B',
      apiKey: 'llm-key',
    });
  });

  it('falls back to Anthropic Claude when no base URL is set', () => {
    const p = resolveAssistantProvider({ anthropicApiKey: 'sk-cloud' });
    expect(p).toMatchObject({
      kind: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      model: DEFAULT_ANTHROPIC_MODEL,
      apiKey: 'sk-cloud',
    });
  });

  it('returns null when nothing is configured', () => {
    expect(resolveAssistantProvider({})).toBeNull();
    expect(resolveAssistantProvider({ baseUrl: '', anthropicApiKey: '' })).toBeNull();
  });
});

describe('speechRecordsOf', () => {
  it('attributes the real engine log across days and contexts, in order', () => {
    const { room, day1Order, day2First } = driveToSpeechDay2();
    const records = speechRecordsOf(room.state.log).map(
      (rec) => `${rec.day}:${rec.seat}:${rec.context}`,
    );
    // Day 1: the two candidacy speeches, seat 5's last words, then the round in order.
    expect(records.slice(0, 3)).toEqual([
      '1:9:sheriff-speech',
      '1:10:sheriff-speech',
      '1:5:last-words',
    ]);
    expect(records.slice(3, -1)).toEqual(day1Order.map((s) => `1:${s}:speech`));
    // Day 2: the first speaker of the new floor (night deaths get no last words).
    expect(records.at(-1)).toBe(`2:${day2First}:speech`);
  });

  it('keeps the raw text of every speech', () => {
    const room = driveToSpeech();
    const records = speechRecordsOf(room.state.log);
    expect(records[0]).toMatchObject({ seat: 9, text: 'candidacy 9' });
    expect(records.some((r) => r.text === 'last words 5')).toBe(true);
  });
});

describe('buildStrategyPrompt', () => {
  it('shows a wolf the pack but never the seer findings', () => {
    const room = driveToSpeech();
    const slot = slotOf(room);
    const wolf = viewFor(room.state, 1);
    const prompt = buildStrategyPrompt(wolf, slot, speechRecordsOf(wolf.log));
    expect(prompt).toContain('你的狼队');
    expect(prompt).toContain('2号'); // a fellow wolf seat shows up in the pack list
    expect(prompt).not.toContain('查验记录');
    expect(prompt).not.toContain('预言家');
  });

  it('shows the seer their own check results and no pack', () => {
    const room = driveToSpeech();
    const slot = slotOf(room);
    const seer = viewFor(room.state, 9);
    const prompt = buildStrategyPrompt(seer, slot, speechRecordsOf(seer.log));
    expect(prompt).toContain('查验记录');
    expect(prompt).toContain('1号=狼人');
    expect(prompt).not.toContain('你的狼队');
  });

  it('leaks no hidden knowledge to a villager', () => {
    const room = driveToSpeech();
    const slot = slotOf(room);
    const villager = viewFor(room.state, 6);
    const prompt = buildStrategyPrompt(villager, slot, speechRecordsOf(villager.log));
    expect(prompt).not.toContain('查验记录');
    expect(prompt).not.toContain('你的狼队');
    // The caller's own row legitimately reads ,身份:村民 — no other role may.
    for (const role of ['狼人', '预言家', '女巫', '猎人', '白痴']) {
      expect(prompt).not.toContain(`身份:${role}`);
    }
    // The public record is still there.
    expect(prompt).toContain('candidacy 9');
    expect(prompt).toContain('last words 5');
  });

  it('names the current speaker, day, and speech context', () => {
    const room = driveToSpeech();
    const slot = slotOf(room);
    const villager = viewFor(room.state, 6);
    const prompt = buildStrategyPrompt(villager, slot, speechRecordsOf(villager.log));
    expect(prompt).toContain('座位:6号');
    expect(prompt).toContain(`轮到${slot?.seat}号发言`);
    expect(prompt).toContain('白天发言');
  });
});

describe('validateStrategyReply', () => {
  it('accepts the documented shape', () => {
    expect(validateStrategyReply(VALID)).toEqual(VALID);
  });

  it('rejects malformed or empty replies', () => {
    expect(validateStrategyReply(null)).toBeNull();
    expect(validateStrategyReply('text')).toBeNull();
    expect(validateStrategyReply({})).toBeNull();
    expect(validateStrategyReply({ ...VALID, lines: 'nope' })).toBeNull();
    expect(validateStrategyReply({ ...VALID, lines: [] })).toBeNull();
    expect(validateStrategyReply({ ...VALID, lines: ['ok', '   '] })).toBeNull();
    expect(validateStrategyReply({ ...VALID, reasoning: '' })).toBeNull();
    expect(validateStrategyReply({ ...VALID, warnings: 'nope' })).toBeNull();
  });

  it('passes padded fields through unchanged', () => {
    const reply = validateStrategyReply({
      lines: ['  要点  '],
      reasoning: ' 原因 ',
      warnings: [],
    });
    expect(reply).toEqual({ lines: ['  要点  '], reasoning: ' 原因 ', warnings: [] });
  });
});

describe('stripReasoningTrace and parseStrategyReply', () => {
  it('separates a reasoning-model trace from the JSON payload', () => {
    expect(
      stripReasoningTrace('<think>内部推理</think>\n{"lines":["a"],"reasoning":"r","warnings":[]}'),
    ).toBe('{"lines":["a"],"reasoning":"r","warnings":[]}');
    expect(stripReasoningTrace(VALID_JSON)).toBe(VALID_JSON);
  });

  it('parses direct JSON, wrapped JSON, and salvages embedded JSON', () => {
    expect(parseStrategyReply(VALID_JSON)).toEqual(VALID);
    expect(parseStrategyReply('<think>推理</think>\n' + VALID_JSON)).toEqual(VALID);
    expect(parseStrategyReply('我的建议：\n' + VALID_JSON + '\n以上。')).toEqual(VALID);
  });

  it('returns null for garbage', () => {
    expect(parseStrategyReply('我觉得应该低调。')).toBeNull();
    expect(parseStrategyReply('{"lines": 1}')).toBeNull();
  });
});

describe('attachAssistant', () => {
  it('acks ASSISTANT_UNAVAILABLE when no provider is configured', async () => {
    const room = driveToSpeech();
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), {});
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, 6);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'ASSISTANT_UNAVAILABLE' });
  });

  it('acks NOT_YOUR_TURN for anyone but the current speaker', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk' });
    const socket = new FakeAssistantSocket();
    const other = (slot?.seat ?? 1) === 1 ? 2 : 1;
    bind(socket, room.code, other);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'NOT_YOUR_TURN' });
  });

  it('acks NOT_IN_ROOM / NO_SEAT for unbound sockets', async () => {
    const room = driveToSpeech();
    const fetchImpl = vi.fn(async () => chatResponse(VALID_JSON));
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    for (const [code, seat, expected] of [
      [null, 1 as Seat | null, 'NOT_IN_ROOM'],
      [room.code, null, 'NO_SEAT'],
      ['MISSING', 1 as Seat | null, 'NOT_IN_ROOM'],
    ] as const) {
      const socket = new FakeAssistantSocket();
      bind(socket, code, seat);
      server.connect(socket);
      expect(await socket.ask()).toEqual({ error: expected });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('acks NO_HISTORY on the first slot of the game', async () => {
    const room = fixedRoom();
    for (let i = 0; i < 12; i++) room.join();
    room.start();
    nightKill(room, 5);
    witchPass(room);
    seerCheck(room, 1);
    for (const c of [9, 10]) room.applyPlayerAction({ type: 'SHERIFF_SIGNUP', actor: c });
    room.proceed(); // -> sheriff-speech, first slot, no speeches yet
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), {
      anthropicApiKey: 'sk',
      fetchImpl: async () => chatResponse(VALID_JSON),
    });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'NO_HISTORY' });
  });

  it('returns a validated strategy reply for the current speaker', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, slot?.seat ?? 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual(VALID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once with a correction after malformed JSON, then errors', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const fetchImpl = vi.fn(async () => anthropicResponse('我觉得应该低调。'));
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, slot?.seat ?? 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'ASSISTANT_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one correction retry, then give up
  });

  it('recovers when the correction retry returns valid JSON', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return anthropicResponse(call === 1 ? '先观察' : VALID_JSON);
    });
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, slot?.seat ?? 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual(VALID);
    expect(call).toBe(2);
  });

  it('separates a reasoning trace before parsing', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const fetchImpl = vi.fn(async () =>
      anthropicResponse(`<think>推理过程</think>\n${VALID_JSON}`),
    );
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, slot?.seat ?? 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual(VALID);
  });

  it('limits requests to three per speech slot', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const seat = slot?.seat ?? 9;
    for (let i = 0; i < 3; i++) {
      const socket = new FakeAssistantSocket();
      bind(socket, room.code, seat);
      server.connect(socket);
      expect(await socket.ask()).toEqual(VALID);
    }
    const fourth = new FakeAssistantSocket();
    bind(fourth, room.code, seat);
    server.connect(fourth);
    expect(await fourth.ask()).toEqual({ error: 'RATE_LIMITED' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('allows one request in flight per seat', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const gate: { release?: (response: Response) => void } = {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          gate.release = resolve;
        }),
    );
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const seat = slot?.seat ?? 9;
    const first = new FakeAssistantSocket();
    bind(first, room.code, seat);
    server.connect(first);
    const firstAck = first.ask();
    const second = new FakeAssistantSocket();
    bind(second, room.code, seat);
    server.connect(second);
    const secondAck = second.ask();
    expect(await secondAck).toEqual({ error: 'ASSISTANT_BUSY' });
    gate.release?.(anthropicResponse(VALID_JSON));
    expect(await firstAck).toEqual(VALID);
  });

  it('resets the slot budget when the slot moves', async () => {
    const room = driveToSpeech();
    const first = room.currentSpeechSlot();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const seat = first?.seat ?? 9;
    for (let i = 0; i < 3; i++) {
      const socket = new FakeAssistantSocket();
      bind(socket, room.code, seat);
      server.connect(socket);
      await socket.ask();
    }
    // Advance the slot (the current speaker speaks and the floor moves on).
    room.applyPlayerAction({ type: 'SPEAK', actor: seat, text: '我的发言' });
    room.proceed();
    const next = room.currentSpeechSlot();
    expect(next?.seat).not.toBe(seat);
    const nextSpeaker = new FakeAssistantSocket();
    bind(nextSpeaker, room.code, next?.seat ?? null);
    server.connect(nextSpeaker);
    // The next seat's first ask is served (fresh budget, shared provider).
    expect(await nextSpeaker.ask()).toEqual(VALID);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('sends the guided-decoding schema and retries without it on a 4xx', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      calls.push({ url: String(input), body: (init?.body as string) ?? '' });
      if (calls.length === 1) {
        return new Response('{"error":{"message":"guided_json not supported"}}', { status: 400 });
      }
      return chatResponse(VALID_JSON);
    });
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), {
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl,
    });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, slot?.seat ?? 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual(VALID);
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    const firstBody = JSON.parse(calls[0]?.body ?? '{}') as {
      response_format?: unknown;
      model: string;
    };
    expect(firstBody.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(firstBody.response_format).toBeTruthy();
    const secondBody = JSON.parse(calls[1]?.body ?? '{}') as {
      response_format?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondBody.response_format).toBeUndefined();
    expect(secondBody.messages.at(-1)?.content).toContain('JSON');
  });

  it('prompts only from the caller projection over the OpenAI-compatible wire', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const wire: { captured?: string } = {};
    const fetchImpl = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      wire.captured = (init?.body as string) ?? '';
      return chatResponse(VALID_JSON);
    });
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { baseUrl: 'http://vllm:8000/v1', fetchImpl });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, slot?.seat ?? 9);
    server.connect(socket);
    await socket.ask();
    const body = JSON.parse(wire.captured ?? '{}') as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages.map((m) => m.content).join('\n');
    // The caller's own view and the public record are present…
    expect(prompt).toContain(`座位:${slot?.seat}号`);
    expect(prompt).toContain('candidacy 9');
    // …and nothing from other seats' private knowledge.
    expect(prompt).not.toContain('查验记录');
    expect(prompt).not.toContain('你的狼队');
  });

  it('speaks the Anthropic wire protocol on the cloud fallback', async () => {
    const room = driveToSpeech();
    const slot = room.currentSpeechSlot();
    const wire: { captured?: { url: string; body: string; headers: Record<string, string> } } = {};
    const fetchImpl = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      wire.captured = {
        url: String(input),
        body: (init?.body as string) ?? '',
        headers: (init?.headers as Record<string, string>) ?? {},
      };
      return anthropicResponse(VALID_JSON);
    });
    const server = new FakeAssistantServer();
    attachAssistant(server, registryOf(room), { anthropicApiKey: 'sk-cloud', fetchImpl });
    const socket = new FakeAssistantSocket();
    bind(socket, room.code, slot?.seat ?? 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual(VALID);
    const captured = wire.captured;
    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured?.headers['x-api-key']).toBe('sk-cloud');
    const body = JSON.parse(captured?.body ?? '{}') as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.messages.map((m) => m.content).join('\n')).toContain('狼人杀');
  });
});
