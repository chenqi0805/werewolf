import type { PlayerAction } from '@werewolf/engine';
import type { PlayerView } from '@werewolf/server';
import type { BotContext, BotDecision, BotStrategy } from './strategy';

/**
 * The LLM brain — prompts a local OpenAI-compatible endpoint (llama.cpp
 * `llama-server` by default) and validates every answer against the bot's
 * own fog-of-war view before it touches the wire.
 *
 * The model is a suggestion, never a gate: timeout, unparseable output, or
 * an illegal action degrade THAT ONE DECISION to the fallback strategy —
 * a game never waits on the model, and a hallucinated action never reaches
 * the server (rejections there are silent fire-and-forget `game:error`s).
 */

/** Minimal OpenAI-compatible chat surface — injectable for tests. */
export interface LlmClient {
  /** Returns the assistant message text for one chat completion. */
  chat(messages: LlmMessage[], opts: { maxTokens: number; timeoutMs: number }): Promise<string>;
}

export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

const SYSTEM_PROMPT = [
  '你是狼人杀游戏中的 AI 玩家。你只能根据给定的视角信息（PlayerView）行动，',
  '绝对不要泄露你视角之外的任何信息。请用一句简短的中文发言参与讨论，',
  '并以严格的 JSON 返回你的决定：{"action": <动作对象>, "speech": "<一句中文发言>"}。',
  '动作对象的格式必须匹配当前阶段：夜晚轮到你时返回你角色的行动',
  '（如 {"type":"WOLF_KILL","actor":<座位>,"target":<座位>}），',
  '发言轮到你时返回 {"type":"SPEAK","actor":<座位>,"text":"..."}，',
  '投票阶段返回 {"type":"EXILE_VOTE","actor":<座位>,"target":<座位|null>}。',
  '不行动时返回对应类型的 PASS/弃票动作。只返回 JSON，不要有其他文字。',
].join('');

/**
 * Builds the model's sensory input: the rules reminder plus the bot's own
 * fog-of-war view and the speech it can hear — nothing else exists for it.
 */
export function buildPrompt(ctx: BotContext): LlmMessage[] {
  const user = JSON.stringify({
    view: ctx.view,
    recentSpeech: ctx.recentSpeech,
  });
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Parses the model's answer into a decision, or null when unparseable. */
export function parseDecision(raw: string): BotDecision | null {
  // Models love to wrap JSON in prose or fences; take the outermost braces.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { action, speech } = parsed as { action?: unknown; speech?: unknown };
  if (typeof action !== 'object' || action === null) return null;
  const decision: BotDecision = {
    action: action as PlayerAction,
    ...(typeof speech === 'string' && speech.length > 0 ? { speech } : {}),
  };
  return decision;
}

/**
 * Client-side pre-validation mirroring the server's own shape and
 * entitlement checks: the actor must be the bot's seat and the action type
 * must be one the current step could legally ask for. Deliberately coarse —
 * the server stays authoritative; a wrong rejection here only means the
 * fallback plays instead.
 */
export function isLegalFor(view: PlayerView, action: PlayerAction): boolean {
  if (view.you.seat === null || action.actor !== view.you.seat) return false;
  const kind = view.step.kind;
  // Widened to string: the server's night-step union predates the guard step
  // (the 预女猎守 wiring is server-side, still pending) — the moment that type
  // grows 'guard', this check accepts it with no change here.
  const night: string | null = view.step.kind === 'night' ? view.step.step : null;
  switch (action.type) {
    case 'WOLF_KILL':
      return night === 'wolf';
    case 'GUARD_PROTECT':
    case 'GUARD_PASS':
      return night === 'guard';
    case 'WITCH_HEAL':
    case 'WITCH_POISON':
    case 'WITCH_PASS':
      return night === 'witch';
    case 'SEER_CHECK':
    case 'SEER_PASS':
      return night === 'seer';
    case 'SHERIFF_SIGNUP':
    case 'SHERIFF_WITHDRAW':
      return kind === 'sheriff-signup';
    case 'SHERIFF_VOTE':
    case 'SHERIFF_PASS':
      return kind === 'sheriff-vote' || (kind === 'pk-vote' && view.step.voteKind === 'sheriff');
    case 'SPEAK':
      return kind === 'speech' || kind === 'last-words' || kind === 'pk-speech';
    case 'EXILE_VOTE':
      return kind === 'exile-vote' || (kind === 'pk-vote' && view.step.voteKind === 'exile');
    case 'HUNTER_SHOOT':
    case 'HUNTER_PASS':
    case 'WOLF_KING_DESTRUCT':
    case 'WOLF_KING_PASS':
      // Both interrupt windows ride the generalized hunter-shot settlement step.
      return kind === 'hunter-shot' && view.step.seat === action.actor;
    case 'SET_SPEECH_DIRECTION':
      return kind === 'speech';
  }
}

export interface LlmStrategyOptions {
  maxTokens?: number;
  timeoutMs?: number;
}

export class LlmStrategy implements BotStrategy {
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(
    /** Scripted fallback — every failure mode degrades to it, per decision. */
    private readonly fallback: BotStrategy,
    private readonly llm: LlmClient,
    opts: LlmStrategyOptions = {},
  ) {
    this.maxTokens = opts.maxTokens ?? 220;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async decide(ctx: BotContext): Promise<BotDecision | null> {
    try {
      const raw = await this.llm.chat(buildPrompt(ctx), {
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs,
      });
      const parsed = parseDecision(raw);
      if (parsed !== null && isLegalFor(ctx.view, parsed.action)) return parsed;
      return this.fallback.decide(ctx);
    } catch {
      // Timeout, endpoint down, anything else — the game never waits on the model.
      return this.fallback.decide(ctx);
    }
  }
}

/** Default client: the OpenAI-compatible chat-completions endpoint over fetch. */
export function fetchLlmClient(baseUrl: string, model: string, apiKey?: string): LlmClient {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== undefined && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
  return {
    async chat(messages, opts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            max_tokens: opts.maxTokens,
            temperature: 0.7,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}`);
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const text = body.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw new Error('LLM endpoint returned no message text');
        return text;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
