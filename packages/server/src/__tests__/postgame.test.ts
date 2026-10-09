import { describe, expect, it, vi } from 'vitest';
import type { Seat } from '@werewolf/engine';
import {
  attachPostgame,
  buildPostgamePrompt,
  parsePostgameReply,
  POSTGAME_JSON_SCHEMA,
  POSTGAME_MAX_TOKENS,
  postgameStatsOf,
  validatePostgameReply,
  type PostgameAck,
  type PostgameReply,
  type PostgameServer,
  type PostgameSocket,
} from '../postgame';
import type { Room, RoomRegistry } from '../room';
import { fixedRoom } from './fixtures';
import { lastWords, nightKill, runSpeech, seerCheck, unanimousExile, witchPass } from './drivers';

const VALID: PostgameReply = {
  summary: '狼人白天带节奏,好人被逐个击破,最终屠边获胜。',
  keyMoments: ['首夜狼刀带走5号', '警长选举9号当选', '7号被放逐出局', '最后一夜屠边'],
  mvp: 1,
  ratings: Array.from({ length: 12 }, (_, i) => ({
    seat: (i + 1) as Seat,
    score: 5,
    rationale: `第${i + 1}号的发挥中规中矩`,
    highlight: `第${i + 1}号的一次关键发言`,
  })),
};

const VALID_JSON = JSON.stringify(VALID);
type FetchInput = Parameters<typeof fetch>[0];

class FakePostgameServer implements PostgameServer {
  private connectionHandler: ((socket: PostgameSocket) => void) | null = null;
  on(_event: 'connection', handler: (socket: PostgameSocket) => void): void {
    this.connectionHandler = handler;
  }
  connect(socket: PostgameSocket): void {
    this.connectionHandler?.(socket);
  }
}

class FakePostgameSocket implements PostgameSocket {
  data: { roomCode: string | null; seat: Seat | null } = { roomCode: null, seat: null };
  private ackHandler: ((ack: PostgameAck) => void) | null = null;
  on(_event: 'postgame:analysis', handler: (ack: PostgameAck) => void): void {
    this.ackHandler = handler;
  }
  ask(): Promise<PostgameReply | { error: string }> {
    return new Promise((resolve) => {
      this.ackHandler?.((resp) => resolve(resp));
    });
  }
}

function anthropicResponse(content: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text: content }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Seat a fake socket into a room (the gateway's socket.data binding). */
function bind(socket: FakePostgameSocket, code: string | null, seat: Seat | null): void {
  socket.data = { roomCode: code, seat };
}

function registryOf(room: Room): Pick<RoomRegistry, 'get'> {
  return { get: (code: string) => (code === room.code ? room : undefined) };
}

/** A finished room: the villager side is wiped by night 3 and the wolves win. */
function driveToGameOver(): Room {
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
  runSpeech(room);
  unanimousExile(room, 7); // a real exile: day 1 closes into night 2
  nightKill(room, 6);
  witchPass(room);
  seerCheck(room, 2);
  // Night-2 deaths get no last words — the dawn proceed reopens the day-2 floor.
  room.proceed(); // dawn-announce -> speech
  if (room.state.speech?.order === null) {
    room.applyPlayerAction({
      type: 'SET_SPEECH_DIRECTION',
      actor: sheriff?.seat ?? 9,
      direction: 'cw',
    });
  }
  runSpeech(room);
  // Day 2 passes without a death.
  const electorate2 = room.state.vote?.electorate ?? [];
  for (const voter of electorate2) {
    room.applyPlayerAction({ type: 'EXILE_VOTE', actor: voter, target: null });
  }
  nightKill(room, 8); // the villager side is wiped
  // The kill resolves as the night's resolution step drains — the win may
  // land on any of these steps, so each one re-checks.
  if (room.state.winner === null) witchPass(room);
  if (room.state.winner === null) seerCheck(room, 11);
  if (room.state.winner === null) room.proceed(); // the last dawn resolves the kill
  if (room.state.winner === null) throw new Error('test setup: game did not finish');
  return room;
}

/** Mid-game room with the day-1 floor open (not finished). */
function driveToSpeechMidGame(): Room {
  const room = fixedRoom();
  for (let i = 0; i < 12; i++) room.join();
  room.start();
  nightKill(room, 5);
  witchPass(room);
  seerCheck(room, 1);
  for (const c of [9, 10]) room.applyPlayerAction({ type: 'SHERIFF_SIGNUP', actor: c });
  room.proceed();
  for (const c of [9, 10]) {
    room.applyPlayerAction({ type: 'SPEAK', actor: c, text: `candidacy ${c}` });
    room.proceed();
  }
  const electorate = room.state.vote?.electorate ?? [];
  for (const voter of electorate) {
    room.applyPlayerAction({ type: 'SHERIFF_VOTE', actor: voter, target: 9 });
  }
  room.proceed();
  lastWords(room, 5);
  const sheriff = Object.values(room.state.players).find((p) => p.hasBadge && p.alive);
  room.applyPlayerAction({
    type: 'SET_SPEECH_DIRECTION',
    actor: sheriff?.seat ?? 9,
    direction: 'cw',
  });
  return room;
}

describe('validatePostgameReply', () => {
  it('accepts the documented shape', () => {
    expect(validatePostgameReply(VALID)).toEqual(VALID);
  });

  it('rejects an out-of-range or non-integer score', () => {
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, score: 11 }] }),
    ).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, score: -1 }] }),
    ).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, score: 5.5 }] }),
    ).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, score: '8' }] }),
    ).toBeNull();
  });

  it('rejects an out-of-range seat, mvp, or duplicate ratings', () => {
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, seat: 13 }] }),
    ).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, seat: 0 }] }),
    ).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, seat: 2.5 }] }),
    ).toBeNull();
    expect(validatePostgameReply({ ...VALID, mvp: 13 })).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [VALID.ratings[0]!, VALID.ratings[0]!] }),
    ).toBeNull();
  });

  it('rejects blank or missing prose', () => {
    expect(validatePostgameReply({ ...VALID, summary: '  ' })).toBeNull();
    expect(validatePostgameReply({ ...VALID, keyMoments: [] })).toBeNull();
    expect(validatePostgameReply({ ...VALID, keyMoments: ['关键', '  '] })).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, rationale: '' }] }),
    ).toBeNull();
    expect(
      validatePostgameReply({ ...VALID, ratings: [{ ...VALID.ratings[0]!, highlight: ' ' }] }),
    ).toBeNull();
    expect(validatePostgameReply({ ...VALID, ratings: [] })).toBeNull();
    expect(validatePostgameReply({})).toBeNull();
  });
});

describe('parsePostgameReply', () => {
  it('parses a direct JSON object', () => {
    expect(parsePostgameReply(VALID_JSON)).toEqual(VALID);
  });

  it('separates a reasoning trace before parsing', () => {
    expect(parsePostgameReply(`<think>推理过程</think>${VALID_JSON}`)).toEqual(VALID);
  });

  it('salvages prose-wrapped JSON', () => {
    expect(parsePostgameReply(`复盘如下:${VALID_JSON} 以上。`)).toEqual(VALID);
  });

  it('returns null for garbage', () => {
    expect(parsePostgameReply('not json at all')).toBeNull();
  });
});

describe('postgameStatsOf', () => {
  it('attributes roles, deaths, and speech/vote accounting from the full log', () => {
    const room = driveToGameOver();
    const stats = postgameStatsOf(room.state);
    expect(stats.map((s) => s.seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const bySeat = new Map(stats.map((s) => [s.seat, s]));
    // Roles and camps across the fixed deck.
    expect(bySeat.get(1)).toMatchObject({ role: 'werewolf', camp: 'wolf', alive: true });
    expect(bySeat.get(5)).toMatchObject({
      role: 'villager',
      camp: 'good',
      alive: false,
      deathCause: 'wolf-kill',
      deathDay: 1,
    });
    expect(bySeat.get(7)).toMatchObject({
      role: 'villager',
      camp: 'good',
      alive: false,
      deathCause: 'exile',
      deathDay: 1,
      votesReceived: 11,
    });
    expect(bySeat.get(6)).toMatchObject({ alive: false, deathCause: 'wolf-kill', deathDay: 2 });
    expect(bySeat.get(8)).toMatchObject({ alive: false, deathCause: 'wolf-kill', deathDay: 3 });
    expect(bySeat.get(9)).toMatchObject({ role: 'seer', alive: true, hasBadge: true });
    expect(bySeat.get(10)).toMatchObject({ role: 'witch', alive: true, hasBadge: false });
    // Seat 5 spoke only his last words; the election speakers spoke three times.
    expect(bySeat.get(5)).toMatchObject({ speeches: 1 });
    expect(bySeat.get(9)).toMatchObject({ speeches: 3 });
    // Seat 1 survived to vote three times: sheriff, day-1 exile, day-2 exile.
    expect(bySeat.get(1)).toMatchObject({ votesCast: 3 });
  });
});

describe('buildPostgamePrompt', () => {
  it('carries the full reveal: every role, the complete speech record, votes, and stats', () => {
    const room = driveToGameOver();
    const prompt = buildPostgamePrompt(room.state);
    // Every role dealt on the classic board appears (game over unmasks all)…
    expect(prompt).toContain('狼人');
    expect(prompt).toContain('村民');
    expect(prompt).toContain('预言家');
    expect(prompt).toContain('女巫');
    expect(prompt).toContain('猎人');
    expect(prompt).toContain('白痴');
    // …every speech of record…
    expect(prompt).toContain('candidacy 9');
    expect(prompt).toContain('last words 5');
    expect(prompt).toContain('speech 6');
    // …the ballot history…
    expect(prompt).toContain('警长投票');
    expect(prompt).toContain('放逐投票');
    // …and the deterministic stats block.
    expect(prompt).toContain('发言 1 段共');
    expect(prompt).toContain('被投 11 票');
    expect(prompt).toContain('狼人阵营');
  });

  it('is deterministic for the same state', () => {
    const room = driveToGameOver();
    expect(buildPostgamePrompt(room.state)).toBe(buildPostgamePrompt(room.state));
  });

  it('inlines the strict output schema', () => {
    const room = driveToGameOver();
    expect(buildPostgamePrompt(room.state)).toContain(JSON.stringify(POSTGAME_JSON_SCHEMA));
  });
});

describe('attachPostgame', () => {
  it('acks NOT_IN_ROOM for a socket with no room binding', async () => {
    const room = driveToGameOver();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakePostgameSocket();
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'NOT_IN_ROOM' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('acks NOT_GAME_OVER while the room is live and never calls the provider', async () => {
    const room = driveToSpeechMidGame();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakePostgameSocket();
    bind(socket, room.code, 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'NOT_GAME_OVER' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('acks ASSISTANT_UNAVAILABLE with no provider configured', async () => {
    const room = driveToGameOver();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { fetchImpl });
    const socket = new FakePostgameSocket();
    bind(socket, room.code, 9);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'ASSISTANT_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the validated reply and arms the generation for any viewer (seat null included)', async () => {
    const room = driveToGameOver();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakePostgameSocket();
    bind(socket, room.code, null); // a finished-room spectator
    server.connect(socket);
    expect(await socket.ask()).toEqual(VALID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once on malformed JSON, then acks POSTGAME_ERROR', async () => {
    const room = driveToGameOver();
    const fetchImpl = vi.fn(async () => anthropicResponse('这不是JSON'));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakePostgameSocket();
    bind(socket, room.code, 3);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'POSTGAME_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('recovers when the correction round returns valid JSON', async () => {
    const room = driveToGameOver();
    const fetchImpl = vi.fn(async () => anthropicResponse('<think>推理</think>依然不是JSON'));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakePostgameSocket();
    bind(socket, room.code, 3);
    server.connect(socket);
    expect(await socket.ask()).toEqual({ error: 'POSTGAME_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent requests into one provider call with identical acks', async () => {
    const room = driveToGameOver();
    const gate: { release?: () => void } = {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          gate.release = () => resolve(anthropicResponse(VALID_JSON));
        }),
    );
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const first = new FakePostgameSocket();
    bind(first, room.code, 1);
    server.connect(first);
    const second = new FakePostgameSocket();
    bind(second, room.code, null);
    server.connect(second);
    const firstAck = first.ask();
    const secondAck = second.ask();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    gate.release?.();
    expect(await firstAck).toEqual(VALID);
    expect(await secondAck).toEqual(VALID);
  });

  it('serves post-completion repeats from the cache with no second provider call', async () => {
    const room = driveToGameOver();
    const fetchImpl = vi.fn(async () => anthropicResponse(VALID_JSON));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const first = new FakePostgameSocket();
    bind(first, room.code, 1);
    server.connect(first);
    expect(await first.ask()).toEqual(VALID);
    for (let i = 0; i < 3; i++) {
      const repeat = new FakePostgameSocket();
      bind(repeat, room.code, i + 2);
      server.connect(repeat);
      expect(await repeat.ask()).toEqual(VALID);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('memoizes a failed generation — a broken provider cannot be hammered per room', async () => {
    const room = driveToGameOver();
    const fetchImpl = vi.fn(async () => anthropicResponse('还是不是JSON'));
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const first = new FakePostgameSocket();
    bind(first, room.code, 1);
    server.connect(first);
    expect(await first.ask()).toEqual({ error: 'POSTGAME_ERROR' });
    const repeat = new FakePostgameSocket();
    bind(repeat, room.code, 2);
    server.connect(repeat);
    expect(await repeat.ask()).toEqual({ error: 'POSTGAME_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the one retry, then nothing
  });

  it('speaks the wire with the postgame schema and the full-reveal prompt', async () => {
    const room = driveToGameOver();
    const wire: { captured?: string } = {};
    const fetchImpl = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      wire.captured = (init?.body as string) ?? '';
      return anthropicResponse(VALID_JSON);
    });
    const server = new FakePostgameServer();
    attachPostgame(server, registryOf(room), { anthropicApiKey: 'sk', fetchImpl });
    const socket = new FakePostgameSocket();
    bind(socket, room.code, 9);
    server.connect(socket);
    await socket.ask();
    const body = JSON.parse(wire.captured ?? '{}') as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.max_tokens).toBe(POSTGAME_MAX_TOKENS);
    const prompt = body.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('预言家');
    expect(prompt).toContain('candidacy 9');
  });
});
