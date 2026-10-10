# werewolf

Standard 12-player 狼人杀 (Werewolf) online multiplayer — a server-authoritative TypeScript monorepo. Product spec: Obvious blueprint `art_bP1gGegs`.

## Status

Full stack (npm workspaces: `packages/engine`, `packages/server`, `packages/web`, `packages/e2e`, shared tooling, GitHub Actions CI on every PR and on `main`, Node 24). The engine implements the complete standard-board ruleset — night resolution (狼人 → 女巫 → 预言家, 空刀 → 平安夜, poison overrides heal), witch potion economy, seer checks, hunter shot interrupts, idiot reveal, the full sheriff election (PK → revote → void, badge 移交/撕毁), and 屠边 win checks — as a pure `applyAction(state, action)` reducer with 93 passing Vitest tests. The room server (Socket.IO rooms, session tokens, phase timers, per-seat filtered views, static hosting of the built client) and the wired React client are merged and deployed; a Playwright e2e package plays two full 12-seat scripted games in CI and against the hosted deployment.

## Stack

- **Runtime** — Node >= 20.19 (CI runs Node 24), npm workspaces
- **Language** — TypeScript 5.9, strict, `moduleResolution: bundler`, typecheck-only (no emit yet)
- **Tests** — Vitest 4, one `test` script per package
- **Lint/format** — ESLint 10 flat config (`eslint.config.js`) with typescript-eslint; Prettier 3
- **Planned** — Socket.IO room server (`packages/server`), React + Vite client (`packages/web`)

## Commands

From the repo root:

| Command | What it does |
| --- | --- |
| `npm install` | install all workspace packages |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run lint` | ESLint across the whole repo |
| `npm run test` | Vitest in every workspace |
| `npm run format:check` / `npm run format` | Prettier check / write |

Run a single package's checks with `npm run <script> -w @werewolf/<pkg>` (e.g. `npm run test -w @werewolf/engine`).

## Ports

- **Room server (serves the built client + Socket.IO from one origin)** — `3210` in the hosted deployment; `WEREWOLF_PORT` overrides. The e2e webServer uses `3100` by default.
- **Vite dev server** — `5173` (client development only; the e2e suite runs against production builds).

## Environment seams (deployment)

Set on the server process, all optional:

- `WEREWOLF_PORT` — HTTP listen port (default `3210`).
- `WEREWOLF_WEB_DIST` — absolute path to the built client (`packages/web/dist`) to serve statically; unset = API only.
- `WEREWOLF_TIMERS` — JSON map of phase clock overrides in ms (keys: `night:wolf`, `night:witch`, `night:seer`, `sheriff-signup`, `sheriff-speech`, `sheriff-vote`, `dawn-announce`, `last-words`, `speech`, `exile-vote`, `pk-speech`, `pk-vote`, `hunter-shot`, `badge-pass`). Unset = standard humane pacing. The hosted verification deployment runs compact clocks so a full game completes in minutes; real-table deployments should leave it unset.
- `WEREWOLF_DB_PATH` — SQLite file backing room persistence (WAL mode, `better-sqlite3` driver). Default `data/werewolf.db` under the server workdir. Unset rooms would be in-memory only — the default keeps them durable across restarts; delete the file to reset all rooms.
- `OPENAI_API_KEY` — arms the server-side STT fallback (`packages/server/src/voice.ts`): speech-slot audio buffered from the voice relay is transcribed and submitted as the slot's `SPEAK` when the client has no transcript by slot end. Unset = browser Web Speech captions only; silent slots pass untouched. `WEREWOLF_STT_MODEL` overrides the model (default `gpt-4o-mini-transcribe`); language is fixed zh-CN.
- Assistant (strategy suggestions, `packages/server/src/assistant.ts`) — resolution order: `WEREWOLF_ASSISTANT_BASE_URL` set → that OpenAI-compatible endpoint is used (self-hosted vLLM `:8000/v1`, Ollama `:11434/v1`, LM Studio, llama.cpp server; `WEREWOLF_ASSISTANT_MODEL` picks the model, e.g. `qwen3:8b`; optional `WEREWOLF_ASSISTANT_API_KEY`); else `ANTHROPIC_API_KEY` set → Claude cloud fallback (Haiku-class default, `WEREWOLF_ASSISTANT_MODEL` overrides); else the assistant acks `ASSISTANT_UNAVAILABLE` and the client shows 未配置. Prompts are built only from the caller's fog-of-war-filtered `PlayerView`; replies are strict-JSON validated server-side; rate limit 3 per speech slot, 1 in flight.
- Bot LLM brain (`packages/bots`, wired in `packages/server/src/start.ts`) — `WEREWOLF_BOTS_LLM_BASE_URL` set → every bot runner prompts that OpenAI-compatible endpoint (llama.cpp `llama-server` serving a small Qwen instruct model on `127.0.0.1:8081` is the shipped pairing; `WEREWOLF_BOTS_LLM_MODEL` picks the model, default `qwen2.5-0.5b-instruct`, optional `WEREWOLF_BOTS_LLM_API_KEY` — empty locally, `WEREWOLF_BOTS_LLM_TIMEOUT_MS` default 8000). Every model answer is legality-validated against the bot's own fog-of-war view; timeout, malformed output, or an unreachable endpoint degrade that one decision to the scripted fallback — a game never waits on the model. Unset = scripted brains only, no model, no network (CI-safe). Live smoke (env-gated, never CI): `WEREWOLF_SMOKE_LLM=1 npm run smoke:llm -w @werewolf/bots` drives one decision per game step over real HTTP and reports fallback rate + chat latency p50/p95; exit 1 only when the endpoint never answers.

Hosted deployment: the server runs on the project sandbox under tmux `svc-3210` (`WEREWOLF_PORT=3210 WEREWOLF_WEB_DIST=... npm run start -w @werewolf/server`), registered for persistent hosting. Rooms persist to SQLite (WAL) at `WEREWOLF_DB_PATH` (default `data/werewolf.db` under the workdir): a pause/wake restarts the process, `restoreRooms` replays each room's action log, and seats, tokens, speeches, votes, and running clocks survive; a room whose log fails to replay is quarantined (logged, skipped) and the server still boots.

## Codebase map

- `packages/e2e` — `@werewolf/e2e`, the Playwright harness. `tests/harness/` bootstraps a 12-seat table from isolated browser contexts and discovers each dealt role from the seat's own page; two full-game scenarios (`tests/wolf-win.spec.ts` — 屠边 via villagers, `tests/good-win.spec.ts` — idiot reveal + hunter shot on the exile path) drive real UIs to the game-over reveal and capture per-seat evidence. Runs in CI as its own job and against a live deployment via `WEREWOLF_BASE_URL`; `scripts/start-server.mjs` boots the production server with compact clocks for local runs.
- `packages/engine` — `@werewolf/engine`, the pure rules engine. Zero I/O; consumes the typed `PlayerAction` protocol (the future AI-bot seam) through `applyAction(state, action) → { state, events }`, deterministic and replayable from the event log.
  - Modules: `types.ts` (roles, seats, private-state unions) · `config.ts` (contested rule knobs) · `actions.ts` (the `PlayerAction`/`GameAction` protocol) · `errors.ts` (`GameError` codes) · `events.ts` (`GameEvent` + per-event visibility: public / server / private) · `state.ts` (GameState, night/speech/vote sub-state, helpers) · `create.ts` (`createGame` lineup validation) · `votes.ts` (ballot accounting) · `resolution.ts` (death application, hunter windows, idiot flips, win checks) · `night.ts` (wolf kill, witch potions, seer checks) · `day.ts` (dawn announce, last words, speeches, exile votes, PK) · `sheriff.ts` (election, PK revote, badge 移交/撕毁) · `engine.ts` (the `applyAction` router) · `index.ts` (public API).
  - Tests: `src/__tests__` — `harness.ts` (shared builders: `newGame`, `baseGame`, `nightKill`, `witchTurn`, `seerTurn`, `holdElection`, `openDay`, `speechRound`, `runNight`, `voteAll`, assertion helpers) plus one suite per rule area (`engine`, `night`, `witch`, `seer`, `hunter`, `idiot`, `sheriff`, `dayflow`, `win`, `fullgame`) — 93 tests mapping one-to-one onto the spec's Engine criteria.
- `packages/server` — `@werewolf/server`, the Socket.IO room server: rooms, session tokens, phase timers, per-seat filtered views, voice relay + server-side STT fallback (`voice.ts`), and the strategy-assistant proxy (`assistant.ts`).
- `packages/bots` — `@werewolf/bots`, the AI bot players: loopback `socket.io-client` runners (`runner.ts`) that consume only fog-of-war `PlayerView`s and emit `PlayerAction`s through the same gateway checks as browsers; one strategy seam (`strategy.ts`) with two brains — `ScriptedStrategy` (`scripted.ts`, deterministic heuristics: CI, e2e, and the live fallback) and `LlmStrategy` (`llm.ts`, local OpenAI-compatible endpoint with per-decision fallback on timeout/malformed/illegal/unreachable). `scripts/smoke-llm.mjs` is the env-gated live smoke (`npm run smoke:llm`).
- `packages/web` — `@werewolf/web`, the React + Vite client: renders `PlayerView`, sends `PlayerAction`.
- `tsconfig.base.json` — shared strict compiler options, extended by every package tsconfig.
- `eslint.config.js`, `.prettierrc.json` / `.prettierignore` — shared lint and format config.
- `.github/workflows/ci.yml` — PR pipeline: `npm ci` → typecheck → lint → test → format check, plus a Playwright e2e job running both 12-seat scenarios.
- Package `exports` point at TS source (`./src/index.ts`) and packages use `moduleResolution: bundler` — the right default for the Vitest dev loop. Cross-package import wiring and any runtime emit strategy land with the PRs that connect the packages.

## Snapshot

A sandbox snapshot exists for the repo sandbox; the deployment recipe above is the canonical way to (re)build a hosted instance from any checkout: `npm ci`, `npm run build -w @werewolf/web`, then start the server with the env seams.
