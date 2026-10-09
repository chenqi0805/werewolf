import type { GameEvent, Role, Seat } from '@werewolf/engine';
import type { RoomRegistry } from './room';
import { currentSpeechSlot, type SpeechContext, type SpeechSlot } from './voice';
import { viewFor, type PlayerView } from './view';

/**
 * The AI speech-strategy assistant — an opt-in proxy, never a player.
 *
 * Every prompt is assembled exclusively from the caller's own fog-of-war
 * projection (viewFor(state, seat)): their role, their private extras, and
 * the public speech record. Raw GameState is unreachable here by
 * construction, so no provider can be told a secret the caller must not see.
 * The reply is strict-JSON zh-CN, validated server-side with one correction
 * retry — the validator, not the prompt, is the output contract.
 *
 * Providers, in resolution order:
 *  1. WEREWOLF_ASSISTANT_BASE_URL — any OpenAI-compatible chat endpoint
 *     (vLLM, Ollama, LM Studio, llama.cpp server). A deliberate deployment
 *     choice: zero per-call cost, runs on the host's own hardware.
 *  2. ANTHROPIC_API_KEY — Claude (Haiku-class default), the zero-setup cloud.
 *  3. Neither — every request acks ASSISTANT_UNAVAILABLE; the panel shows
 *     未配置 and nothing else happens.
 */

export interface StrategyReply {
  /** 可照念的发言要点 — first-person, spoken-style zh. */
  lines: string[];
  /** 策略逻辑 — why these lines for this seat's position. */
  reasoning: string;
  /** 风险提醒 — what this speech might expose or provoke. */
  warnings: string[];
}

export type AssistantProvider =
  | { kind: 'openai-compatible'; url: string; model: string; apiKey: string | null }
  | { kind: 'anthropic'; url: string; model: string; apiKey: string };

export interface AssistantOptions {
  /** WEREWOLF_ASSISTANT_BASE_URL — OpenAI-compatible endpoint; wins when set. */
  baseUrl?: string;
  /** WEREWOLF_ASSISTANT_MODEL — flavors whichever provider resolves. */
  model?: string;
  /** WEREWOLF_ASSISTANT_API_KEY — optional; local endpoints often need none. */
  apiKey?: string;
  /** ANTHROPIC_API_KEY — cloud fallback when no base URL is configured. */
  anthropicApiKey?: string;
  /** Test seam: replace the outbound HTTP call. Never set in production. */
  fetchImpl?: typeof fetch;
  /** Test seam: requests per speech slot (default 3). */
  maxRequestsPerSlot?: number;
}

/** 8B-class default for self-hosted endpoints — serviceable, shallow vs Claude. */
export const DEFAULT_LOCAL_MODEL = 'qwen3:8b';

/** Claude Haiku-class — the latency-appropriate cloud tier for a speech slot. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';

export const ASSISTANT_MAX_TOKENS = 1024;

/**
 * Explicit resolution: a configured base URL wins (it is a deployment
 * choice); no base URL and a Claude key falls back to the cloud; neither
 * degrades to ASSISTANT_UNAVAILABLE.
 */
export function resolveAssistantProvider(opts: AssistantOptions): AssistantProvider | null {
  if (opts.baseUrl !== undefined && opts.baseUrl !== '') {
    return {
      kind: 'openai-compatible',
      url: `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      model: opts.model ?? DEFAULT_LOCAL_MODEL,
      apiKey: opts.apiKey ?? null,
    };
  }
  if (opts.anthropicApiKey !== undefined && opts.anthropicApiKey !== '') {
    return {
      kind: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      model: opts.model ?? DEFAULT_ANTHROPIC_MODEL,
      apiKey: opts.anthropicApiKey,
    };
  }
  return null;
}

/** One attributed speech in the public record. */
export interface SpeechRecord {
  day: number;
  context: SpeechContext;
  seat: Seat;
  text: string;
}

/**
 * The public speech slice of a seat-filtered log, attributed to game days by
 * walking the NIGHT_BEGAN / DAY_BROKE markers in order — the same derivation
 * the client's per-day history uses, kept pure so the server and the client
 * agree on the record. Last marker wins: day-1 candidacy speeches predate
 * DAY_BROKE(1) and still belong to day 1 via NIGHT_BEGAN(1).
 */
export function speechRecordsOf(log: readonly GameEvent[]): SpeechRecord[] {
  const records: SpeechRecord[] = [];
  let day = 0;
  for (const event of log) {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      day = event.dayNumber;
      continue;
    }
    if (event.type === 'SPEECH_MADE') {
      records.push({ day, context: event.context, seat: event.seat, text: event.text });
    }
  }
  return records;
}

const ROLE_LABELS: Record<Role, string> = {
  werewolf: '狼人',
  villager: '村民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  idiot: '白痴',
};

const CONTEXT_LABELS: Record<SpeechContext, string> = {
  'sheriff-speech': '警长竞选发言',
  'last-words': '遗言',
  speech: '白天发言',
  'pk-speech': 'PK发言',
};

/** Strict output schema — inlined into the prompt and sent as guided decoding. */
export const STRATEGY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'reasoning', 'warnings'],
  properties: {
    lines: { type: 'array', items: { type: 'string' }, minItems: 1 },
    reasoning: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * Assembles the strategy prompt from the caller's projection only. Every
 * string here traces to the PlayerView: roles appear exactly when the view
 * shows them (own card, wolf pack, public flips), private extras only for
 * their owner. This function is the prompt-purity surface — it takes no
 * GameState and cannot.
 */
export function buildStrategyPrompt(
  view: PlayerView,
  slot: SpeechSlot,
  records: SpeechRecord[],
): string {
  const you = view.you;
  const lines: string[] = [
    '你是狼人杀桌游的发言助手,帮当前玩家组织即将说出口的发言。只依据下面给出的信息推理,不要假设任何未公开的信息。',
    '',
    '## 输出格式(严格遵守)',
    '只输出一个 JSON 对象,不要使用 Markdown 代码块,不要输出 JSON 以外的任何文字,字段与类型如下:',
    JSON.stringify(STRATEGY_JSON_SCHEMA),
    '- lines: 可照念的发言要点,第一人称,口语化,普通话',
    '- reasoning: 策略逻辑简述',
    '- warnings: 风险提醒',
    '',
    '## 你的身份',
    `- 座位:${you.seat}号`,
    `- 角色:${you.role === null ? '未知' : ROLE_LABELS[you.role]}`,
    `- 状态:${you.alive ? '存活' : '已出局'}`,
    `- 警徽:${you.hasBadge ? '有' : '无'}`,
  ];
  if (you.wolfPack !== undefined) {
    lines.push(`- 你的狼队:${you.wolfPack.map((s) => `${s}号`).join('、')}`);
  }
  if (you.seerChecks !== undefined) {
    const checks = Object.entries(you.seerChecks)
      .map(([seat, camp]) => `${seat}号=${camp === 'wolf' ? '狼人' : '好人'}`)
      .join('、');
    lines.push(`- 你的查验记录:${checks === '' ? '暂无' : checks}`);
  }
  if (you.witchPotions !== undefined) {
    lines.push(
      `- 女巫药水:解药${you.witchPotions.healUsed ? '已用' : '未用'},毒药${you.witchPotions.poisonUsed ? '已用' : '未用'}`,
    );
  }
  if (you.hunterShotUsed !== undefined) {
    lines.push(`- 开枪技能:${you.hunterShotUsed ? '已用' : '未用'}`);
  }
  lines.push(
    '',
    '## 当前局面',
    `- 第${view.dayNumber}天,发言场景:${CONTEXT_LABELS[slot.context]},轮到${slot.seat}号发言`,
    '',
    '## 在座玩家',
  );
  for (const row of view.players) {
    const role = row.role === null ? '' : `,身份:${ROLE_LABELS[row.role]}`;
    lines.push(
      `- ${row.seat}号:${row.alive ? '存活' : '出局'}${row.hasBadge ? ',警徽' : ''}${role}`,
    );
  }
  lines.push('', '## 此前发言记录');
  let lastDay = -1;
  for (const record of records) {
    if (record.day !== lastDay) {
      lines.push(`第${record.day}天:`);
      lastDay = record.day;
    }
    lines.push(`- ${record.seat}号(${CONTEXT_LABELS[record.context]}):“${record.text}”`);
  }
  if (records.length === 0) lines.push('(还没有发言记录)');
  lines.push('', '请给出针对当前处境的发言建议。');
  return lines.join('\n');
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AssistantProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantProviderError';
  }
}

const JSON_CORRECTION_PROMPT =
  '你上一条回复不是合法的 JSON 对象。请重新回答,只输出一个符合上述字段的 JSON 对象,不要输出任何其他文字。';

/**
 * One provider round trip. The OpenAI-compatible path tries guided decoding
 * first (structured outputs where the runtime supports it) and falls back to
 * a plain request when the endpoint rejects the field — belt and suspenders,
 * one extra attempt, never more.
 */
async function askProvider(
  provider: AssistantProvider,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
): Promise<string | null> {
  if (provider.kind === 'anthropic') {
    const response = await fetchImpl(provider.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: ASSISTANT_MAX_TOKENS,
        messages,
      }),
    });
    if (!response.ok) throw new AssistantProviderError(`HTTP ${response.status}`);
    return textFromAnthropic(await response.json());
  }
  for (const guided of [true, false]) {
    const response = await fetchImpl(provider.url, {
      method: 'POST',
      headers:
        provider.apiKey === null
          ? { 'content-type': 'application/json' }
          : {
              'content-type': 'application/json',
              Authorization: `Bearer ${provider.apiKey}`,
            },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: ASSISTANT_MAX_TOKENS,
        messages,
        ...(guided
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'strategy_reply', strict: true, schema: STRATEGY_JSON_SCHEMA },
              },
            }
          : {}),
      }),
    });
    if (!response.ok) {
      // A 4xx under guided decoding usually means the runtime does not know
      // response_format — retry once without it before giving up.
      if (guided && response.status >= 400 && response.status < 500) continue;
      throw new AssistantProviderError(`HTTP ${response.status}`);
    }
    return textFromChatCompletion(await response.json());
  }
  throw new AssistantProviderError('unreachable');
}

function textFromChatCompletion(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = choices[0]?.message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

function textFromAnthropic(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const content = (parsed as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/**
 * Parses and validates a provider reply into a StrategyReply. Reasoning-mode
 * traces (Qwen3 <think> blocks) are separated before parsing; prose-wrapped
 * JSON is salvaged by taking the outermost object. Anything else is invalid.
 */
export function parseStrategyReply(raw: string): StrategyReply | null {
  const stripped = stripReasoningTrace(raw);
  const direct = tryParseJson(stripped);
  if (direct !== null) return validateStrategyReply(direct);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const salvaged = tryParseJson(stripped.slice(start, end + 1));
    if (salvaged !== null) return validateStrategyReply(salvaged);
  }
  return null;
}

/** Reasoning-mode models prepend <think>…</think> — separated before parsing. */
export function stripReasoningTrace(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The output contract: three exact fields, the right types, nothing empty. */
export function validateStrategyReply(value: unknown): StrategyReply | null {
  if (typeof value !== 'object' || value === null) return null;
  const { lines, reasoning, warnings } = value as {
    lines?: unknown;
    reasoning?: unknown;
    warnings?: unknown;
  };
  if (!isStringArray(lines) || lines.length === 0) return null;
  if (lines.some((line) => line.trim().length === 0)) return null;
  if (typeof reasoning !== 'string' || reasoning.trim().length === 0) return null;
  if (!isStringArray(warnings)) return null;
  return { lines, reasoning, warnings };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The strict-JSON retry: one correction round, then the request fails. */
async function askForReply(
  provider: AssistantProvider,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
): Promise<StrategyReply | null> {
  const first = await askProvider(provider, messages, fetchImpl);
  if (first === null) return null;
  const parsed = parseStrategyReply(first);
  if (parsed !== null) return parsed;
  messages.push({ role: 'assistant', content: first });
  messages.push({ role: 'user', content: JSON_CORRECTION_PROMPT });
  const second = await askProvider(provider, messages, fetchImpl);
  return second === null ? null : parseStrategyReply(second);
}

/** Ack-shaped event — the reply (or a stable error code) comes back per socket. */
export interface AssistantAck {
  (resp: StrategyReply | { error: string }): void;
}

/** Structural view of a bound socket — the gateway's sockets fit as-is. */
export interface AssistantSocket {
  readonly data: { roomCode: string | null; seat: Seat | null };
  on(event: 'assistant:strategy', handler: (ack: AssistantAck) => void): void;
}

export interface AssistantServer {
  on(event: 'connection', handler: (socket: AssistantSocket) => void): void;
}

/** Ack error codes for assistant:strategy — stable protocol values. */
export const ASSISTANT_ERROR_CODES = [
  'NOT_IN_ROOM',
  'NO_SEAT',
  'ASSISTANT_UNAVAILABLE',
  'NOT_YOUR_TURN',
  'NO_HISTORY',
  'RATE_LIMITED',
  'ASSISTANT_BUSY',
  'ASSISTANT_ERROR',
] as const;

interface SlotBudget {
  slotKey: string;
  count: number;
  inflight: boolean;
}

/**
 * Registers the assistant:strategy handler. Always attached: with no
 * provider configured every request still acks — ASSISTANT_UNAVAILABLE — so
 * clients never hang on a missing feature.
 */
export function attachAssistant(
  io: AssistantServer,
  registry: Pick<RoomRegistry, 'get'>,
  opts: AssistantOptions = {},
): void {
  const provider = resolveAssistantProvider(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRequests = opts.maxRequestsPerSlot ?? 3;
  const budgets = new Map<string, SlotBudget>();

  io.on('connection', (socket) => {
    socket.on('assistant:strategy', (ack) => {
      if (typeof ack !== 'function') return;
      const { roomCode, seat } = socket.data;
      const room = roomCode !== null ? registry.get(roomCode) : undefined;
      if (!room) {
        ack({ error: 'NOT_IN_ROOM' });
        return;
      }
      if (seat === null) {
        ack({ error: 'NO_SEAT' });
        return;
      }
      if (!provider) {
        ack({ error: 'ASSISTANT_UNAVAILABLE' });
        return;
      }
      const slot = currentSpeechSlot(room.state);
      // The gate is the turn, not aliveness: a last-words speaker is dead by
      // definition and still holds the floor.
      if (slot === null || slot.seat !== seat) {
        ack({ error: 'NOT_YOUR_TURN' });
        return;
      }
      const view = viewFor(room.state, seat);
      const records = speechRecordsOf(view.log);
      if (records.length === 0) {
        ack({ error: 'NO_HISTORY' });
        return;
      }

      const budgetKey = `${room.code}:${seat}`;
      let budget = budgets.get(budgetKey);
      if (budget === undefined || budget.slotKey !== slot.key) {
        budget = { slotKey: slot.key, count: 0, inflight: false };
        budgets.set(budgetKey, budget);
      }
      if (budget.inflight) {
        ack({ error: 'ASSISTANT_BUSY' });
        return;
      }
      if (budget.count >= maxRequests) {
        ack({ error: 'RATE_LIMITED' });
        return;
      }
      budget.count += 1;
      budget.inflight = true;

      const messages: ChatMessage[] = [
        { role: 'user', content: buildStrategyPrompt(view, slot, records) },
      ];
      void (async () => {
        try {
          const reply = await askForReply(provider, messages, fetchImpl);
          if (reply === null) {
            ack({ error: 'ASSISTANT_ERROR' });
            return;
          }
          ack(reply);
        } catch (error) {
          console.error('[werewolf] assistant: strategy request failed:', error);
          ack({ error: 'ASSISTANT_ERROR' });
        } finally {
          budget.inflight = false;
        }
      })();
    });
  });
}
