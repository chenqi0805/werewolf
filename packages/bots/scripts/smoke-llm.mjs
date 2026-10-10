/**
 * Live smoke for the LLM bot brain — env-gated, NEVER part of CI.
 *
 *   WEREWOLF_SMOKE_LLM=1 npm run smoke:llm -w @werewolf/bots
 *
 * Requires an OpenAI-compatible endpoint (llama.cpp `llama-server` on
 * 127.0.0.1:8081 by default — see `.obvious/obvious.md` for the env seams).
 * For each representative game step the script drives the production
 * decision path — `fetchLlmClient` → `LlmStrategy` → `ScriptedStrategy`
 * fallback — over real HTTP, records whether the model's answer survived
 * legality validation or degraded to the fallback, and prints chat latency
 * p50/p95. Exit 1 only when the endpoint never answered: a per-decision
 * fallback degradation is by design, not a failure.
 *
 * Env (beyond the gate):
 *   WEREWOLF_BOTS_LLM_BASE_URL    default http://127.0.0.1:8081/v1
 *   WEREWOLF_BOTS_LLM_MODEL       default qwen2.5-0.5b-instruct
 *   WEREWOLF_BOTS_LLM_API_KEY     optional (empty for a local llama-server)
 *   WEREWOLF_BOTS_LLM_TIMEOUT_MS  default 8000
 *   WEREWOLF_SMOKE_LLM_ROUNDS     decisions per scenario, default 2
 */

import {
  LlmStrategy,
  ScriptedStrategy,
  fetchLlmClient,
  mulberry32,
  seedFromString,
} from '@werewolf/bots';

// — gate: absent → print and exit 0, so even an accidental invocation in CI
// stays green and touches no network. —

const gate = process.env.WEREWOLF_SMOKE_LLM;
if (gate !== '1' && gate !== 'true') {
  console.log(
    'smoke:llm skipped — set WEREWOLF_SMOKE_LLM=1 with a reachable OpenAI-compatible endpoint to run it.',
  );
  process.exit(0);
}

// — config (mirrors start.ts's parseBotBrainEnv) —

const baseUrl = process.env.WEREWOLF_BOTS_LLM_BASE_URL || 'http://127.0.0.1:8081/v1';
const model = process.env.WEREWOLF_BOTS_LLM_MODEL || 'qwen2.5-0.5b-instruct';
const apiKey = process.env.WEREWOLF_BOTS_LLM_API_KEY;
const timeoutMs = Number(process.env.WEREWOLF_BOTS_LLM_TIMEOUT_MS || 8000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(
    'smoke:llm: WEREWOLF_BOTS_LLM_TIMEOUT_MS must be a positive number of milliseconds.',
  );
  process.exit(2);
}
const rounds = Number(process.env.WEREWOLF_SMOKE_LLM_ROUNDS || 2);
if (!Number.isInteger(rounds) || rounds <= 0) {
  console.error('smoke:llm: WEREWOLF_SMOKE_LLM_ROUNDS must be a positive integer.');
  process.exit(2);
}

// — one representative fog-of-war view per decision kind. Views are honest
// PlayerView shapes (self role visible, everyone else fogged) so the model
// is prompted exactly as it would be in a live game. —

const SEAT_COUNT = 12;

function you(seat, role, extras = {}) {
  return {
    seat,
    role,
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 1,
    ...extras,
  };
}

function table(viewer) {
  return Array.from({ length: SEAT_COUNT }, (_, i) => {
    const seat = i + 1;
    const alive = seat !== 8 && seat !== 9;
    return {
      seat,
      alive,
      hasBadge: seat === 2,
      revealedIdiot: false,
      voteWeight: seat === 2 ? 1.5 : 1,
      occupied: true,
      isBot: false,
      botName: null,
      // Fog of war: only the viewer's own row carries a role.
      role: seat === viewer.seat ? viewer.role : null,
    };
  });
}

function view(phase, step, viewer, log = []) {
  return {
    phase,
    dayNumber: 2,
    winner: null,
    you: viewer,
    players: table(viewer),
    step,
    log,
    timer: { key: phase, endsAt: Date.now() + 30_000 },
  };
}

const SCENARIOS = [
  {
    name: '夜晚 · 狼人刀 (night/wolf)',
    ctx: {
      view: view(
        'night',
        { kind: 'night', step: 'wolf' },
        you(3, 'werewolf', { wolfPack: [2, 3, 12] }),
      ),
      recentSpeech: [],
    },
  },
  {
    name: '夜晚 · 守卫守人 (night/guard)',
    ctx: {
      view: view('night', { kind: 'night', step: 'guard' }, you(6, 'guard')),
      recentSpeech: [],
    },
  },
  {
    name: '夜晚 · 女巫用药 (night/witch)',
    ctx: {
      view: view(
        'night',
        { kind: 'night', step: 'witch' },
        you(4, 'witch', { witchPotions: { healUsed: false, poisonUsed: false, killTarget: 5 } }),
      ),
      recentSpeech: [],
    },
  },
  {
    name: '夜晚 · 预言家验人 (night/seer)',
    ctx: {
      view: view(
        'night',
        { kind: 'night', step: 'seer' },
        you(5, 'seer', { seerChecks: { 7: 'good' } }),
      ),
      recentSpeech: [],
    },
  },
  {
    name: '白天 · 发言 (speech)',
    ctx: {
      view: view(
        'speech',
        { kind: 'speech', order: [2, 3, 4, 5, 6, 7], cursor: 4 },
        you(6, 'villager'),
      ),
      recentSpeech: ['3号昨天带偏了节奏，我觉得要警觉。', '我是平民，请大家理性分析。'],
    },
  },
  {
    name: '白天 · 放逐投票 (exile-vote)',
    ctx: {
      view: view(
        'exile-vote',
        { kind: 'exile-vote', electorate: [1, 2, 3, 4, 5, 6, 7, 10, 11, 12] },
        you(1, 'villager'),
      ),
      recentSpeech: ['我觉得11号的发言像狼。'],
    },
  },
];

// — instrumentation: time every chat round-trip, notice fallback usage —

function timedClient(client, samples) {
  return {
    async chat(messages, opts) {
      const t0 = process.hrtime.bigint();
      try {
        const text = await client.chat(messages, opts);
        samples.push({ ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
        return text;
      } catch (err) {
        samples.push({
          ok: false,
          ms: Number(process.hrtime.bigint() - t0) / 1e6,
          error: String(err),
        });
        throw err;
      }
    },
  };
}

function countingFallback(hits) {
  const fallback = new ScriptedStrategy();
  return {
    async decide(ctx) {
      hits.count += 1;
      return fallback.decide(ctx);
    },
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.max(0, rank)];
}

function describeDecision(decision) {
  if (decision === null) return '— (nothing owed)';
  const { action, speech } = decision;
  const target = 'target' in action ? ` → ${action.target ?? '空'}号` : '';
  const note = speech !== undefined && action.type !== 'SPEAK' ? `  发言:"${speech}"` : '';
  const text = action.type === 'SPEAK' ? ` "${action.text}"` : '';
  return `${action.type}${target}${text}${note}`;
}

// — run —

console.log(
  `smoke:llm → ${baseUrl}  model=${model}  timeout=${timeoutMs}ms  rounds=${rounds}/scenario`,
);

const samples = [];
const hits = { count: 0 };
const strategy = new LlmStrategy(
  countingFallback(hits),
  timedClient(fetchLlmClient(baseUrl, model, apiKey), samples),
);
const rng = mulberry32(seedFromString('smoke-llm'));

let total = 0;
for (const { name, ctx } of SCENARIOS) {
  for (let round = 1; round <= rounds; round++) {
    const before = hits.count;
    const decision = await strategy.decide({ ...ctx, rng });
    const usedFallback = hits.count > before;
    const chat = samples.at(-1);
    const latency =
      chat && chat.ok ? ` ${Math.round(chat.ms)}ms` : chat ? ` ✗ ${Math.round(chat.ms)}ms` : '';
    console.log(
      `  [${name} r${round}] ${usedFallback ? 'fallback' : 'model'}  ${describeDecision(decision)}${latency}`,
    );
    total += 1;
  }
}

const ok = samples
  .filter((s) => s.ok)
  .map((s) => s.ms)
  .sort((a, b) => a - b);
const failed = samples.length - ok.length;
const p50 = percentile(ok, 0.5);
const p95 = percentile(ok, 0.95);

console.log(
  `summary: ${total} decisions · chat ${ok.length} ok / ${failed} failed` +
    (p50 !== null ? ` · p50 ${Math.round(p50)}ms` : '') +
    (p95 !== null ? ` · p95 ${Math.round(p95)}ms` : '') +
    ` · fallback ${hits.count}/${total}`,
);

if (ok.length === 0) {
  console.error(
    'smoke:llm FAILED — the endpoint never answered (unreachable, timed out, or HTTP errors).',
  );
  process.exit(1);
}
console.log('smoke:llm OK');
