# werewolf

Standard 12-player 狼人杀 (Werewolf) online multiplayer — a server-authoritative TypeScript monorepo. Product spec: Obvious blueprint `art_bP1gGegs`.

## Status

Full stack (npm workspaces: `packages/engine`, `packages/server`, `packages/web`, `packages/e2e`, shared tooling, GitHub Actions CI on every PR and on `main`, Node 24). The engine implements the complete standard-board ruleset — night resolution (狼人 → 女巫 → 预言家, 空刀 → 平安夜, poison overrides heal), witch potion economy, seer checks, hunter shot interrupts, idiot reveal, the full sheriff election (PK → revote → void, badge 移交/撕毁), and 屠边 win checks — as a pure `applyAction(state, action)` reducer with 148 passing Vitest tests. The room server (Socket.IO rooms, session tokens, phase timers, per-seat filtered views, SQLite persistence, static hosting of the built client) and the wired React client are merged and deployed. v2 is live: both board templates (「标准局 · 预女猎白」 and 「白狼王局 · 预女猎守」 with guard night step + 白狼王 destruct), host-managed AI bot seats (scripted or local-LLM brains), and room durability across restarts. A Playwright e2e package plays four full 12-seat scripted games plus a lobby flow in CI and against the hosted deployment.

## Stack

- **Runtime** — Node >= 20.19 (CI runs Node 24), npm workspaces
- **Language** — TypeScript 5.9, strict, `moduleResolution: bundler`, typecheck-only (no emit yet)
- **Tests** — Vitest 4, one `test` script per package
- **Lint/format** — ESLint 10 flat config (`eslint.config.js`) with typescript-eslint; Prettier 3
- **Persistence** — SQLite in WAL mode via `better-sqlite3`; the append-only action log is the record, replayed on boot

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
- **llama-server (bot LLM brain)** — `127.0.0.1:8081`, loopback only, tmux `svc-8081` on the project sandbox.
- **Phase-routing grammar proxy** — `127.0.0.1:8082`, loopback only, tmux `svc-8082` on the project sandbox; see the LLM stack runbook below.

## Environment seams (deployment)

Set on the server process, all optional:

- `WEREWOLF_PORT` — HTTP listen port (default `3210`).
- `WEREWOLF_WEB_DIST` — absolute path to the built client (`packages/web/dist`) to serve statically; unset = API only.
- `WEREWOLF_TIMERS` — JSON map of phase clock overrides in ms (keys: `night:wolf`, `night:witch`, `night:seer`, `sheriff-signup`, `sheriff-speech`, `sheriff-vote`, `dawn-announce`, `last-words`, `speech`, `exile-vote`, `pk-speech`, `pk-vote`, `hunter-shot`, `badge-pass`). Unset = standard humane pacing. The hosted deployment runs humane clocks now that bots play live; e2e runs override them with compact clocks via `WEREWOLF_E2E_TIMERS`.
- `WEREWOLF_DB_PATH` — SQLite file backing room persistence (WAL mode, `better-sqlite3` driver). Default `data/werewolf.db` under the server workdir. Unset rooms would be in-memory only — the default keeps them durable across restarts; delete the file to reset all rooms.
- `OPENAI_API_KEY` — arms the server-side STT fallback (`packages/server/src/voice.ts`): speech-slot audio buffered from the voice relay is transcribed and submitted as the slot's `SPEAK` when the client has no transcript by slot end. Unset = browser Web Speech captions only; silent slots pass untouched. `WEREWOLF_STT_MODEL` overrides the model (default `gpt-4o-mini-transcribe`); language is fixed zh-CN.
- Assistant (strategy suggestions, `packages/server/src/assistant.ts`) — resolution order: `WEREWOLF_ASSISTANT_BASE_URL` set → that OpenAI-compatible endpoint is used (self-hosted vLLM `:8000/v1`, Ollama `:11434/v1`, LM Studio, llama.cpp server; `WEREWOLF_ASSISTANT_MODEL` picks the model, e.g. `qwen3:8b`; optional `WEREWOLF_ASSISTANT_API_KEY`); else `ANTHROPIC_API_KEY` set → Claude cloud fallback (Haiku-class default, `WEREWOLF_ASSISTANT_MODEL` overrides); else the assistant acks `ASSISTANT_UNAVAILABLE` and the client shows 未配置. Prompts are built only from the caller's fog-of-war-filtered `PlayerView`; replies are strict-JSON validated server-side; rate limit 3 per speech slot, 1 in flight.
- Email invites (`packages/server/src/invites.ts`) — `RESEND_API_KEY` (a verified-sender Resend key) plus boot-validated `WEREWOLF_PUBLIC_BASE_URL` arm the Resend sender: a seated player's `room:invite` ack event sends a one-shot join-link email (`${WEREWOLF_PUBLIC_BASE_URL}/?room=CODE`), budgeted 1 in flight / 10 per lobby per seat; `WEREWOLF_INVITE_FROM` overrides the from-address (default: Resend's onboarding sender). Key unset → every request still acks (`INVITE_UNAVAILABLE`) and the lobby view drops the `inviteAvailable` hint, so the web client hides the 邮件邀请 affordance and the e2e boots pin the env unconfigured.
- Bot LLM brain (`packages/bots`, wired in `packages/server/src/start.ts`) — `WEREWOLF_BOTS_LLM_BASE_URL` set → every bot runner prompts that OpenAI-compatible endpoint. The shipped pairing points the base URL at the **phase-routing grammar proxy on `127.0.0.1:8082/v1`** (which forwards to `llama-server` on `8081`; see the LLM stack runbook below — the proxy constrains each completion to the current step's legal actions, which took the live fallback rate from 26/30 to 3/30). `WEREWOLF_BOTS_LLM_MODEL` picks the model (default `qwen2.5-0.5b-instruct`), optional `WEREWOLF_BOTS_LLM_API_KEY` (empty locally), `WEREWOLF_BOTS_LLM_TIMEOUT_MS` (default 8000; the hosted deployment uses 20000 — ~10× the measured p95). Every model answer is legality-validated against the bot's own fog-of-war view; timeout, malformed output, or an unreachable endpoint degrade that one decision to the scripted fallback — a game never waits on the model. Unset = scripted brains only, no model, no network (CI-safe). Live smoke (env-gated, never CI): `WEREWOLF_SMOKE_LLM=1 npm run smoke:llm -w @werewolf/bots` drives one decision per game step over real HTTP and reports fallback rate + chat latency p50/p95; exit 1 only when the endpoint never answers.

Hosted deployment: the server runs on the project sandbox under tmux `svc-3210`, registered for persistent hosting, with **humane clocks** (`WEREWOLF_TIMERS` unset — the compact verification clocks are retired now that bots play live) and an explicit `WEREWOLF_DB_PATH=/home/user/work/werewolf/data/werewolf.db`. The full startup command is the one registered in `obvious hosted get`. Rooms persist to SQLite (WAL): a pause/wake or any process restart re-runs `restoreRooms`, which replays each room's action log; seats, token hashes, speeches, votes, and running clocks survive. **Live verification (2026-10-10):** a 12-seat LLM-bot game (room created, 11 bots added, night resolved — 4-wolf coordinated kill healed by the witch — speeches delivered) was killed with SIGKILL mid-speech; on restart the host reattached with the pre-kill token, all captured history came back byte-identical (7/7 events), and the persisted speech deadline was restored verbatim — the game continued uninterrupted. A room whose log fails to replay is quarantined (logged, skipped) and the server still boots.

**DB vs snapshot rebuilds (probed empirically):** the DB file lives on the project sandbox's working disk and survives process restarts and pause/wake, but a **sandbox snapshot rebuild wipes it** — a reset restores only baked-snapshot content (verified on the repo sandbox: probe files outside the checkout and uncommitted files inside it were both discarded; only snapshot-baked content returned). There is no snapshot mechanism for the project sandbox. Therefore: **back up the DB before any deliberate project-sandbox rebuild** (`sqlite3 $WEREWOLF_DB_PATH ".backup '/home/user/work/werewolf/data/backup.db'"` or a plain file copy). If a rebuild catches it anyway, the loss is loud, not silent — the server boots with an empty registry and new rooms mint fresh codes.

## LLM stack runbook (project sandbox — `/home/user/work/llama`)

The bot brain stack lives on the **project sandbox**, not in the repo or the repo sandbox. It is NOT covered by any snapshot — a project-sandbox rebuild deletes it and it must be re-provisioned (steps below, ~2 minutes of work).

- **Binary** — llama.cpp prebuilt CPU binaries, release **b11539** (Ubuntu 24.04 x64), at `/home/user/work/llama/llama-b11539/`. No build step. Known quirk of this build: the default JSON-schema paths (`-j`, `-jf`, per-request `response_format`) fail with `Failed to initialize samplers`; **GBNF grammars work** — the stack relies on them exclusively.
- **Model** — Qwen2.5-0.5B-Instruct **Q4_K_M GGUF**, 491,400,032 bytes (~469 MiB, ~0.4 GB RAM resident), at `/home/user/work/llama/models/qwen2.5-0.5b-instruct-q4_k_m.gguf`. Instruction-tuned, Chinese-strong, comfortably within the 2-core sandbox budget.
- **Constrained decoding, two layers** (both files in `/home/user/work/llama/`):
  1. `bot-decision.gbnf` — the catch-all grammar passed to `llama-server` via `--grammar-file`. Every completion is forced into the `BotDecision` envelope `{"action": <one of 19 PlayerAction variants>, "speech": "…"}` with seats constrained to 1–12.
  2. `phase-proxy.mjs` — a zero-dependency Node proxy on `127.0.0.1:8082` that forwards to `8081`. The bot's request body already carries its own fog-of-war view; the proxy reads `view.step` and `view.you.seat` from it and injects llama-server's per-request `grammar` field, narrowing the action set to what the current step legally allows and pinning the actor seat. It adds no information the bot did not already have. Rationale: with the catch-all grammar alone the 0.5B model picks phase-wrong actions (it anchored on `WOLF_KILL` in every phase — 26/30 smoke decisions fell back); with the proxy the fallback rate dropped to 3/30 and chat p95 from 6165 ms to 2085 ms.
- **tmux sessions** (both must be up before `svc-3210` starts, or bot decisions simply degrade to scripted):
  - `svc-8081`: `/home/user/work/llama/llama-b11539/llama-server -m /home/user/work/llama/models/qwen2.5-0.5b-instruct-q4_k_m.gguf --alias qwen2.5-0.5b-instruct --host 127.0.0.1 --port 8081 -c 32768 --parallel 8 -t 2 --cache-reuse 256 --grammar-file /home/user/work/llama/bot-decision.gbnf`
  - `svc-8082`: `node /home/user/work/llama/phase-proxy.mjs`
- **Re-provision after a rebuild**: recreate `/home/user/work/llama/`, download the b11539 prebuilt archive and the GGUF (both single-URL fetches; verify the model is exactly 491,400,032 bytes), restore the two files, restart both tmux sessions in order (`svc-8081`, then `svc-8082`), then restart `svc-3210` (its env already points at the proxy). Verify with `curl -s http://127.0.0.1:8081/health` through the proxy (`curl -s http://127.0.0.1:8082/health`) and one `smoke:llm` run.
- **Measured live profile (2026-10-10, through the proxy)**: 30 smoke decisions — fallback 3/30, chat p50 1564 ms, p95 2085 ms. In the live game, ~12 seats of night actions + speeches advanced on humane clocks without a stall.

## Codebase map

- `packages/e2e` — `@werewolf/e2e`, the Playwright harness. `tests/harness/` bootstraps a 12-seat table from isolated browser contexts and discovers each dealt role from the seat's own page; five spec files — four full-game scenarios (`tests/wolf-win.spec.ts` 屠边 via villagers, `tests/good-win.spec.ts` idiot reveal + hunter shot, `tests/wolfking-win.spec.ts` guard save + 白狼王 destruct, `tests/bot-mix.spec.ts` mixed human/bot table) plus `tests/lobby.spec.ts` (lobby flow: board picker, bot controls, start gate) — drive real UIs and capture per-seat evidence. Runs in CI as its own job and against a live deployment via `WEREWOLF_BASE_URL`; `scripts/start-server.mjs` boots the production server with compact clocks for local runs.
- `packages/engine` — `@werewolf/engine`, the pure rules engine. Zero I/O; consumes the typed `PlayerAction` protocol (the future AI-bot seam) through `applyAction(state, action) → { state, events }`, deterministic and replayable from the event log.
  - Modules: `types.ts` (roles, seats, private-state unions) · `config.ts` (contested rule knobs) · `actions.ts` (the `PlayerAction`/`GameAction` protocol) · `errors.ts` (`GameError` codes) · `events.ts` (`GameEvent` + per-event visibility: public / server / private) · `state.ts` (GameState, night/speech/vote sub-state, helpers) · `create.ts` (`createGame` lineup validation) · `votes.ts` (ballot accounting) · `resolution.ts` (death application, hunter windows, idiot flips, win checks) · `night.ts` (wolf kill, witch potions, seer checks) · `day.ts` (dawn announce, last words, speeches, exile votes, PK) · `sheriff.ts` (election, PK revote, badge 移交/撕毁) · `engine.ts` (the `applyAction` router) · `index.ts` (public API).
  - Tests: `src/__tests__` — `harness.ts` (shared builders: `newGame`, `baseGame`, `nightKill`, `witchTurn`, `seerTurn`, `holdElection`, `openDay`, `speechRound`, `runNight`, `voteAll`, assertion helpers) plus one suite per rule area (`engine`, `night`, `witch`, `seer`, `hunter`, `idiot`, `sheriff`, `dayflow`, `win`, `fullgame`) and the v2 suites (`guard`, 白狼王, lineup validation, win variants) — 148 tests total.
- `packages/server` — `@werewolf/server`, the Socket.IO room server: rooms, session tokens, phase timers, per-seat filtered views, voice relay + server-side STT fallback (`voice.ts`), the strategy-assistant proxy (`assistant.ts`), and the email-invite sender (`invites.ts`).
- `packages/bots` — `@werewolf/bots`, the AI bot players: loopback `socket.io-client` runners (`runner.ts`) that consume only fog-of-war `PlayerView`s and emit `PlayerAction`s through the same gateway checks as browsers; one strategy seam (`strategy.ts`) with two brains — `ScriptedStrategy` (`scripted.ts`, deterministic heuristics: CI, e2e, and the live fallback) and `LlmStrategy` (`llm.ts`, local OpenAI-compatible endpoint with per-decision fallback on timeout/malformed/illegal/unreachable). `scripts/smoke-llm.mjs` is the env-gated live smoke (`npm run smoke:llm`).
- `packages/web` — `@werewolf/web`, the React + Vite client: renders `PlayerView`, sends `PlayerAction`. v2 surfaces: board picker and the `?room=CODE` invite-link prefill on `ConnectScreen`, host-only bot controls and the `inviteAvailable`-gated 邮件邀请 block on `LobbyScreen`, `GuardPad` and the 白狼王 `DestructControl` (confirmation flow), shared role metadata imported from the engine's board registry.
- `tsconfig.base.json` — shared strict compiler options, extended by every package tsconfig.
- `eslint.config.js`, `.prettierrc.json` / `.prettierignore` — shared lint and format config.
- `.github/workflows/ci.yml` — PR pipeline: `npm ci` → typecheck → lint → test → format check, plus a Playwright e2e job running the four 12-seat game scenarios and the lobby flow.
- Package `exports` point at TS source (`./src/index.ts`) and packages use `moduleResolution: bundler` — the right default for the Vitest dev loop. Cross-package import wiring and any runtime emit strategy land with the PRs that connect the packages.

## Snapshot

The repo sandbox dev-stack snapshot is E2B template `waxwybdkzadfvv81w7um:default` (captured 2026-10-10; contains the checkout at `fce7e93` with `node_modules` installed). A rebuild from this snapshot discards everything not baked in — verified empirically with probe files (working-disk files outside the checkout and uncommitted files inside it are both wiped; `node_modules` and the clean checkout survive). The llama.cpp + model + grammar/proxy stack lives on the project sandbox and is **not** covered by any snapshot — see the LLM stack runbook above for the re-provision steps, and back up `WEREWOLF_DB_PATH` before any deliberate project-sandbox rebuild. The deployment recipe above is the canonical way to (re)build a hosted instance from any checkout: `npm ci`, `npm run build -w @werewolf/web`, then start the server with the env seams.
