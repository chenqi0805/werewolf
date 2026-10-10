import type { DeathCause, GameState, Role, Seat } from '@werewolf/engine';
import { BOARDS, campOf, SEAT_COUNT } from '@werewolf/engine';
import type { RoomRegistry } from './room';
import {
  askStrictJson,
  CONTEXT_LABELS,
  defaultProviderFetch,
  parseStrictJsonObject,
  resolveAssistantProvider,
  ROLE_LABELS,
  speechRecordsOf,
  type AssistantOptions,
  type AssistantProvider,
  type AskSpec,
} from './assistant';

/**
 * The post-game 复盘 — one AI generation per finished room, shared table-wide.
 *
 * The game is over: every role is public, so the prompt is built from the raw
 * GameState — fog-of-war scoping is a live-game invariant only. The reply is
 * strict-JSON zh-CN, validated server-side with one correction retry (the
 * same discipline the strategy assistant runs), and exactly one generation
 * per room is ever attempted: concurrent requests join the same in-flight
 * promise, and post-completion repeats are served from the memoized result
 * with no second provider call. The cache dies with the in-memory room.
 *
 * Providers are resolved exactly as assistant.ts resolves them — the F5 env
 * seams (WEREWOLF_ASSISTANT_BASE_URL → ANTHROPIC_API_KEY → none). No
 * environment variable of its own.
 */

export interface PostgameRating {
  seat: Seat;
  /** 0–10 integer performance score. */
  score: number;
  /** 评分理由 — zh, judged from the player's own speeches + outcome + role. */
  rationale: string;
  /** One-line zh — the player's best single contribution. */
  highlight: string;
}

export interface PostgameReply {
  /** 3–6 句中文复盘: night arc, key kills/exiles, how the win closed. */
  summary: string;
  /** 3–5 个关键节点 (zh). */
  keyMoments: string[];
  /** Seat of 本场最佳. */
  mvp: Seat;
  ratings: PostgameRating[];
}

/**
 * Same resolution order and same env vars as the strategy assistant — a
 * deliberate deployment choice covers both features at once.
 */
export type PostgameOptions = Pick<
  AssistantOptions,
  'baseUrl' | 'model' | 'apiKey' | 'anthropicApiKey' | 'fetchImpl'
>;

/** The 复盘 reply is a dozen ratings plus prose — twice the strategy budget. */
export const POSTGAME_MAX_TOKENS = 2048;

/** Strict output schema — inlined into the prompt and sent as guided decoding. */
export const POSTGAME_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'keyMoments', 'mvp', 'ratings'],
  properties: {
    summary: { type: 'string' },
    keyMoments: { type: 'array', items: { type: 'string' }, minItems: 1 },
    mvp: { type: 'integer', minimum: 1, maximum: SEAT_COUNT },
    ratings: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seat', 'score', 'rationale', 'highlight'],
        properties: {
          seat: { type: 'integer', minimum: 1, maximum: SEAT_COUNT },
          score: { type: 'integer', minimum: 0, maximum: 10 },
          rationale: { type: 'string' },
          highlight: { type: 'string' },
        },
      },
    },
  },
} as const;

const POSTGAME_SPEC: AskSpec = {
  schemaName: 'postgame_reply',
  schema: POSTGAME_JSON_SCHEMA,
  maxTokens: POSTGAME_MAX_TOKENS,
};

/** Ack error codes for postgame:analysis — stable protocol values. */
export const POSTGAME_ERROR_CODES = [
  'NOT_IN_ROOM',
  'NOT_GAME_OVER',
  'ASSISTANT_UNAVAILABLE',
  'POSTGAME_ERROR',
] as const;

const DEATH_LABELS: Record<DeathCause, string> = {
  'wolf-kill': '夜间遇害',
  poison: '毒杀',
  exile: '放逐出局',
  shot: '被枪带走',
  'self-destruct': '自爆出局',
};

const CAMP_LABELS: Record<ReturnType<typeof campOf>, string> = {
  wolf: '狼人阵营',
  good: '好人阵营',
};

/** Deterministic per-player accounting, walked once off the full log. */
export interface PostgameStat {
  seat: Seat;
  role: Role;
  camp: ReturnType<typeof campOf>;
  alive: boolean;
  hasBadge: boolean;
  /** Day number (per the log's NIGHT_BEGAN/DAY_BROKE markers) of the death. */
  deathDay: number | null;
  deathCause: DeathCause | null;
  speeches: number;
  speechChars: number;
  /** Sheriff + exile ballots cast (abstentions included). */
  votesCast: number;
  /** Exile votes the seat received. */
  votesReceived: number;
}

/**
 * The deterministic stats block, derived from raw state + log — the same
 * derivation the client's postgameStatsOf performs on its view. Game over
 * unmasks the log's server-only events (votes, death causes), so this sees
 * the full ballot and death record.
 */
export function postgameStatsOf(state: GameState): PostgameStat[] {
  const bySeat = new Map<Seat, PostgameStat>();
  for (const player of Object.values(state.players)) {
    bySeat.set(player.seat, {
      seat: player.seat,
      role: player.role,
      camp: campOf(player.role),
      alive: player.alive,
      hasBadge: player.hasBadge,
      deathDay: null,
      deathCause: null,
      speeches: 0,
      speechChars: 0,
      votesCast: 0,
      votesReceived: 0,
    });
  }
  let day = 0;
  for (const event of state.log) {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      day = event.dayNumber;
      continue;
    }
    switch (event.type) {
      case 'SPEECH_MADE': {
        const stat = bySeat.get(event.seat);
        if (stat) {
          stat.speeches += 1;
          stat.speechChars += event.text.length;
        }
        break;
      }
      case 'SHERIFF_VOTE_CAST': {
        const stat = bySeat.get(event.actor);
        if (stat) stat.votesCast += 1;
        break;
      }
      case 'EXILE_VOTE_CAST': {
        const actor = bySeat.get(event.actor);
        if (actor) actor.votesCast += 1;
        if (event.target !== null) {
          const target = bySeat.get(event.target);
          if (target) target.votesReceived += 1;
        }
        break;
      }
      case 'DEATH_RESOLVED': {
        const stat = bySeat.get(event.seat);
        if (stat && stat.deathCause === null) {
          stat.deathCause = event.cause;
          stat.deathDay = day;
        }
        break;
      }
      default:
        break;
    }
  }
  return [...bySeat.values()].sort((a, b) => a.seat - b.seat);
}

/**
 * Assembles the 复盘 prompt from the fully revealed game. Every role, the
 * complete public speech record, the full ballot history, and the
 * deterministic stats block are all in — game over unmasks everything, so
 * this takes the raw GameState on purpose.
 */
export function buildPostgamePrompt(state: GameState): string {
  const stats = postgameStatsOf(state);
  const records = speechRecordsOf(state.log);
  const lines: string[] = [
    '你是狼人杀桌游的复盘助手。比赛已经结束,所有身份都已公开。请通读下面的完整对局记录,给出这场比赛的复盘。',
    '',
    '## 输出格式(严格遵守)',
    '只输出一个 JSON 对象,不要使用 Markdown 代码块,不要输出 JSON 以外的任何文字,字段与类型如下:',
    JSON.stringify(POSTGAME_JSON_SCHEMA),
    '- summary: 3~6 句中文复盘,概括夜晚节奏、关键击杀与放逐,以及胜负如何奠定',
    '- keyMoments: 3~5 个关键节点,每个一句话(中文)',
    '- mvp: 本场最佳玩家的座位号(整数)',
    '- ratings: 每位玩家一条;score 为 0~10 的整数评分,rationale 说明评分理由,highlight 点出其最亮的一次贡献(中文)',
    '',
    '## 比赛结果',
    `- 对局板子:${BOARDS[state.board].name}`,
    `- 获胜阵营:${state.winner === 'wolves' ? CAMP_LABELS.wolf : CAMP_LABELS.good}`,
    `- 比赛历时:${state.dayNumber} 天`,
    '',
    '## 座位与身份(全部公开)',
  ];
  for (const stat of stats) {
    const fate = stat.alive
      ? '存活到最后'
      : `第${stat.deathDay ?? '?'}天${DEATH_LABELS[stat.deathCause ?? 'wolf-kill']}`;
    lines.push(
      `- ${stat.seat}号:${ROLE_LABELS[stat.role]},${CAMP_LABELS[stat.camp]},${fate}${stat.hasBadge ? ',曾持警徽' : ''}`,
    );
  }
  lines.push('', '## 发言记录');
  let lastDay = -1;
  for (const record of records) {
    if (record.day !== lastDay) {
      lines.push(`第${record.day}天:`);
      lastDay = record.day;
    }
    lines.push(`- ${record.seat}号(${CONTEXT_LABELS[record.context]}):“${record.text}”`);
  }
  if (records.length === 0) lines.push('(还没有发言记录)');
  lines.push('', '## 投票记录');
  let voted = false;
  lastDay = -1;
  for (const event of state.log) {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      lastDay = event.dayNumber;
      continue;
    }
    if (event.type === 'SHERIFF_VOTE_CAST' || event.type === 'EXILE_VOTE_CAST') {
      lines.push(
        `- 第${lastDay}天 ${event.type === 'SHERIFF_VOTE_CAST' ? '警长投票' : '放逐投票'}:${event.actor}号 → ${event.target === null ? '弃权' : `${event.target}号`}`,
      );
      voted = true;
    }
  }
  if (!voted) lines.push('(没有投票记录)');
  lines.push('', '## 全场数据');
  for (const stat of stats) {
    lines.push(
      `- ${stat.seat}号:发言 ${stat.speeches} 段共 ${stat.speechChars} 字,投票 ${stat.votesCast} 次,被投 ${stat.votesReceived} 票`,
    );
  }
  lines.push('', '请给出本场复盘,严格按"输出格式"返回 JSON。');
  return lines.join('\n');
}

/** Parses and validates a provider reply into a PostgameReply. */
export function parsePostgameReply(raw: string): PostgameReply | null {
  return parseStrictJsonObject(raw, validatePostgameReply);
}

function toSeat(value: unknown): Seat | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SEAT_COUNT
    ? value
    : null;
}

/**
 * The output contract: every seat rated exactly once with an integer 0–10
 * score, a non-empty summary, and at least one key moment — an out-of-range
 * seat, score 11, or blank text is invalid and burns the one retry.
 */
export function validatePostgameReply(value: unknown): PostgameReply | null {
  if (typeof value !== 'object' || value === null) return null;
  const { summary, keyMoments, mvp, ratings } = value as {
    summary?: unknown;
    keyMoments?: unknown;
    mvp?: unknown;
    ratings?: unknown;
  };
  if (typeof summary !== 'string' || summary.trim().length === 0) return null;
  if (!isStringArray(keyMoments) || keyMoments.length === 0) return null;
  if (keyMoments.some((moment) => moment.trim().length === 0)) return null;
  const mvpSeat = toSeat(mvp);
  if (mvpSeat === null) return null;
  if (!Array.isArray(ratings) || ratings.length === 0) return null;
  const seen = new Set<Seat>();
  const clean: PostgameRating[] = [];
  for (const rating of ratings) {
    if (typeof rating !== 'object' || rating === null) return null;
    const { seat, score, rationale, highlight } = rating as {
      seat?: unknown;
      score?: unknown;
      rationale?: unknown;
      highlight?: unknown;
    };
    const seatNumber = toSeat(seat);
    if (seatNumber === null) return null;
    if (seen.has(seatNumber)) return null;
    seen.add(seatNumber);
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) {
      return null;
    }
    if (typeof rationale !== 'string' || rationale.trim().length === 0) return null;
    if (typeof highlight !== 'string' || highlight.trim().length === 0) return null;
    clean.push({ seat: seatNumber, score, rationale, highlight });
  }
  // The contract is every seat rated exactly once: a provider that omits
  // seats must burn the correction retry, not render a partial 评分 table.
  if (seen.size !== SEAT_COUNT) return null;
  return { summary, keyMoments, mvp: mvpSeat, ratings: clean };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Ack-shaped event — the shared reply (or a stable error code) per socket. */
export interface PostgameAck {
  (resp: PostgameReply | { error: string }): void;
}

/** Structural view of a bound socket — the gateway's sockets fit as-is. */
export interface PostgameSocket {
  readonly data: { roomCode: string | null; seat: Seat | null };
  on(event: 'postgame:analysis', handler: (ack: PostgameAck) => void): void;
}

export interface PostgameServer {
  on(event: 'connection', handler: (socket: PostgameSocket) => void): void;
}

/**
 * Registers the postgame:analysis handler. Always attached: with no provider
 * configured every request still acks — ASSISTANT_UNAVAILABLE — so clients
 * never hang on a missing feature.
 *
 * The generation gate is the room, not the seat: seated players, the dead,
 * and spectators of a finished room all read the same reveal, and any one of
 * them arming the generation arms it for the whole table.
 */
export function attachPostgame(
  io: PostgameServer,
  registry: Pick<RoomRegistry, 'get'>,
  opts: PostgameOptions = {},
): void {
  const provider: AssistantProvider | null = resolveAssistantProvider(opts);
  const fetchImpl = opts.fetchImpl ?? defaultProviderFetch;
  /**
   * One entry per room, never evicted: rooms live for the process lifetime
   * and the room's 复盘 is attempted exactly once — a failed generation is
   * memoized as an error for later requests too, so a broken provider cannot
   * be hammered per room.
   */
  const generations = new Map<string, Promise<PostgameReply | null>>();

  io.on('connection', (socket) => {
    socket.on('postgame:analysis', (ack) => {
      if (typeof ack !== 'function') return;
      const roomCode = socket.data.roomCode;
      const room = roomCode !== null ? registry.get(roomCode) : undefined;
      if (!room) {
        ack({ error: 'NOT_IN_ROOM' });
        return;
      }
      if (room.state.winner === null) {
        ack({ error: 'NOT_GAME_OVER' });
        return;
      }
      if (!provider) {
        ack({ error: 'ASSISTANT_UNAVAILABLE' });
        return;
      }

      const code = room.code;
      let generation = generations.get(code);
      if (generation === undefined) {
        generation = askStrictJson<PostgameReply>(
          provider,
          [{ role: 'user', content: buildPostgamePrompt(room.state) }],
          fetchImpl,
          parsePostgameReply,
          POSTGAME_SPEC,
        ).catch((error: unknown) => {
          console.error(`[werewolf] room ${code}: postgame generation failed:`, error);
          return null;
        });
        // Set synchronously, before the provider's first byte: every request
        // arriving while the generation runs joins this exact promise.
        generations.set(code, generation);
      }
      void generation.then((reply) => {
        ack(reply ?? { error: 'POSTGAME_ERROR' });
      });
    });
  });
}
