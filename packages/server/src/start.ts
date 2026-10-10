import { createApp } from './gateway';
import type { AppOptions, TimerOverrides } from './gateway';
import { parseLimits } from './limits';
import type { AssistantOptions } from './assistant';
import { DEFAULT_INVITE_FROM, validatePublicBaseUrl, type InviteOptions } from './invites';
import type { VoiceOptions } from './voice';
import type { BotStrategy } from '@werewolf/bots';
import { fetchLlmClient, LlmStrategy, ScriptedStrategy } from '@werewolf/bots';
import { serveStatic } from './static';
import { resolve } from 'node:path';

// Dev/production entry: boots the room server on one HTTP port. The Vite dev
// server proxies /socket.io here; in production the same process can serve
// the built client itself (WEREWOLF_WEB_DIST) behind one origin.
const port = Number(process.env.WEREWOLF_PORT ?? process.env.PORT ?? 3000);
const timers = parseTimers(process.env.WEREWOLF_TIMERS);
const limits = parseLimits(process.env.WEREWOLF_LIMITS);
const webDist = process.env.WEREWOLF_WEB_DIST;
const voice = parseVoiceEnv();
const assistant = parseAssistantEnv();
const invites = parseInviteEnv();
const botBrains = parseBotBrainEnv();
// Rooms persist by default: the SQLite file lands under the working
// directory (the hosted deployment's workdir), so rooms, tokens, speeches,
// votes, and clocks survive a restart. WEREWOLF_DB_PATH relocates it.
const dbPath = process.env.WEREWOLF_DB_PATH ?? resolve('data', 'werewolf.db');

const opts: AppOptions = {};
if (timers !== null) opts.timers = timers;
if (limits !== null) opts.limits = limits;
if (voice !== null) opts.voice = voice;
if (assistant !== null) {
  opts.assistant = assistant;
  // The 复盘 rides the same provider env — no separate postgame config exists.
  opts.postgame = assistant;
}
if (botBrains !== null) opts.botStrategyFactory = botBrains;
if (invites !== null) opts.invites = invites;

const app = createApp({ ...opts, dbPath });
if (webDist !== undefined && webDist !== '') {
  app.httpServer.on('request', serveStatic(webDist));
}

app.httpServer.listen(port, () => {
  // The bound port, not the configured one — WEREWOLF_PORT=0 means the OS
  // assigns, and callers (tests, orchestrators) parse this line.
  const addr = app.httpServer.address();
  const bound = typeof addr === 'object' && addr !== null ? addr.port : port;
  console.log(`werewolf room server listening on :${bound}`);
  console.log(`werewolf rooms persist to ${dbPath}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`received ${signal}, shutting down`);
  void app
    .close()
    .then(() => process.exit(0))
    .catch((err) => {
      // Teardown must never die as an unhandled rejection mid-cleanup: a
      // failing close step is logged and surfaces as a nonzero exit for
      // supervisors, instead of truncating teardown with exit-code noise.
      console.error('shutdown failed:', err);
      process.exit(1);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * WEREWOLF_TIMERS is a JSON object of clock-key → milliseconds overrides
 * (e.g. `{"speech":1500}`). Test and demo deployments shrink the phase clocks
 * through this seam; unset keeps the humane defaults. Operator errors fail
 * loudly at boot rather than silently racing a live room.
 */
function parseTimers(raw: string | undefined): TimerOverrides | null {
  if (raw === undefined || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`WEREWOLF_TIMERS is not valid JSON: ${String(error)}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('WEREWOLF_TIMERS must be a JSON object of { clockKey: milliseconds }.');
  }
  const out: TimerOverrides = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`WEREWOLF_TIMERS.${key} must be a positive number of milliseconds.`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * OPENAI_API_KEY arms the server-side STT fallback (WEREWOLF_STT_MODEL
 * overrides the model, default gpt-4o-mini-transcribe; zh-CN fixed — the
 * table speaks Mandarin). Unset = browser Web Speech captions only; speech
 * slots without a client transcript pass silently.
 */
function parseVoiceEnv(): VoiceOptions | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === '') return null;
  return {
    stt: {
      provider: 'openai',
      apiKey,
      model: process.env.WEREWOLF_STT_MODEL ?? 'gpt-4o-mini-transcribe',
      language: 'zh-CN',
    },
  };
}

/**
 * WEREWOLF_BOTS_LLM_BASE_URL arms the LLM bot brain: every bot runner asks
 * that OpenAI-compatible endpoint (llama.cpp llama-server serving a small
 * Qwen instruct model is the shipped pairing) and degrades each decision to
 * the scripted fallback on timeout, illegal output, or an unreachable
 * endpoint. Unset = scripted brains only — no model, no network, CI-safe.
 */
function parseBotBrainEnv(): (() => BotStrategy) | null {
  const baseUrl = process.env.WEREWOLF_BOTS_LLM_BASE_URL;
  if (baseUrl === undefined || baseUrl === '') return null;
  const rawTimeout = process.env.WEREWOLF_BOTS_LLM_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined ? 8000 : Number(rawTimeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('WEREWOLF_BOTS_LLM_TIMEOUT_MS must be a positive number of milliseconds.');
  }
  const client = fetchLlmClient(
    baseUrl,
    process.env.WEREWOLF_BOTS_LLM_MODEL ?? 'qwen2.5-0.5b-instruct',
    process.env.WEREWOLF_BOTS_LLM_API_KEY,
  );
  return () => new LlmStrategy(new ScriptedStrategy(), client, { timeoutMs });
}

/**
 * Assistant provider resolution, evaluated at boot:
 *   1. WEREWOLF_ASSISTANT_BASE_URL — self-hosted OpenAI-compatible endpoint
 *      (vLLM `:8000/v1`, Ollama `:11434/v1`, LM Studio, llama.cpp server);
 *      model from WEREWOLF_ASSISTANT_MODEL (default qwen3:8b), key optional.
 *   2. ANTHROPIC_API_KEY — Claude cloud fallback (Haiku-class default),
 *      model from WEREWOLF_ASSISTANT_MODEL when set.
 *   3. Neither — the assistant acks ASSISTANT_UNAVAILABLE (panel shows 未配置).
 */
function parseAssistantEnv(): AssistantOptions | null {
  const baseUrl = process.env.WEREWOLF_ASSISTANT_BASE_URL;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const hasBaseUrl = baseUrl !== undefined && baseUrl !== '';
  const hasAnthropic = anthropicApiKey !== undefined && anthropicApiKey !== '';
  if (!hasBaseUrl && !hasAnthropic) return null;
  return {
    baseUrl,
    apiKey: process.env.WEREWOLF_ASSISTANT_API_KEY,
    model: process.env.WEREWOLF_ASSISTANT_MODEL,
    anthropicApiKey,
  };
}

/**
 * Email invites (room:invite → Resend's HTTPS API). RESEND_API_KEY arms the
 * sender; WEREWOLF_PUBLIC_BASE_URL seeds every invite link and is validated
 * at boot — links are built from this operator input, never from per-request
 * Host headers, which a client can spoof. WEREWOLF_INVITE_FROM overrides the
 * from-address (default: Resend's onboarding sender). Key unset → the event
 * still answers, acking INVITE_UNAVAILABLE, and the lobby hides the
 * affordance. A key without a base URL is an operator mistake and fails
 * loudly here: links cannot be built without the public origin.
 */
function parseInviteEnv(): InviteOptions | null {
  const apiKey = process.env.RESEND_API_KEY;
  const hasKey = apiKey !== undefined && apiKey !== '';
  if (!hasKey) {
    // Even without a key, a set-but-garbage base URL is an operator mistake —
    // fail loudly at boot rather than silently ignoring the input.
    const raw = process.env.WEREWOLF_PUBLIC_BASE_URL;
    if (raw !== undefined && raw !== '') validatePublicBaseUrl(raw);
    return null;
  }
  const rawBaseUrl = process.env.WEREWOLF_PUBLIC_BASE_URL;
  if (rawBaseUrl === undefined || rawBaseUrl === '') {
    throw new Error(
      'RESEND_API_KEY is set but WEREWOLF_PUBLIC_BASE_URL is missing — invite links need a public base URL.',
    );
  }
  const from = process.env.WEREWOLF_INVITE_FROM;
  return {
    baseUrl: validatePublicBaseUrl(rawBaseUrl),
    from: from !== undefined && from !== '' ? from : DEFAULT_INVITE_FROM,
    apiKey,
  };
}
