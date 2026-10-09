import { createApp } from './gateway';
import type { GatewayOptions, TimerOverrides } from './gateway';
import type { AssistantOptions } from './assistant';
import type { VoiceOptions } from './voice';
import { serveStatic } from './static';

// Dev/production entry: boots the room server on one HTTP port. The Vite dev
// server proxies /socket.io here; in production the same process can serve
// the built client itself (WEREWOLF_WEB_DIST) behind one origin.
const port = Number(process.env.WEREWOLF_PORT ?? process.env.PORT ?? 3000);
const timers = parseTimers(process.env.WEREWOLF_TIMERS);
const webDist = process.env.WEREWOLF_WEB_DIST;
const voice = parseVoiceEnv();
const assistant = parseAssistantEnv();

const opts: GatewayOptions = {};
if (timers !== null) opts.timers = timers;
if (voice !== null) opts.voice = voice;
if (assistant !== null) opts.assistant = assistant;

const app = createApp(opts);
if (webDist !== undefined && webDist !== '') {
  app.httpServer.on('request', serveStatic(webDist));
}

app.httpServer.listen(port, () => {
  console.log(`werewolf room server listening on :${port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`received ${signal}, shutting down`);
  void app.close().then(() => process.exit(0));
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
