# werewolf

Standard 12-player 狼人杀 (Werewolf) online multiplayer — a server-authoritative TypeScript monorepo. Product spec: Obvious blueprint `art_bP1gGegs`.

## Status

Monorepo scaffold (npm workspaces with `packages/engine`, `packages/server`, `packages/web`, shared tooling, GitHub Actions CI on every PR and on `main`, Node 24). The engine package now implements the complete standard-board ruleset — night resolution (狼人 → 女巫 → 预言家, 空刀 → 平安夜, poison overrides heal), witch potion economy, seer checks, hunter shot interrupts, idiot reveal, the full sheriff election (PK → revote → void, badge 移交/撕毁), and 屠边 win checks — as a pure `applyAction(state, action)` reducer with 93 passing Vitest tests. The room server and client remain placeholder shells and land in their own PRs.

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

None yet. The Socket.IO server (future `packages/server`) and the Vite dev server (future `packages/web`) will define ports when they land.

## Codebase map

- `packages/engine` — `@werewolf/engine`, the pure rules engine. Zero I/O; consumes the typed `PlayerAction` protocol (the future AI-bot seam) through `applyAction(state, action) → { state, events }`, deterministic and replayable from the event log.
  - Modules: `types.ts` (roles, seats, private-state unions) · `config.ts` (contested rule knobs) · `actions.ts` (the `PlayerAction`/`GameAction` protocol) · `errors.ts` (`GameError` codes) · `events.ts` (`GameEvent` + per-event visibility: public / server / private) · `state.ts` (GameState, night/speech/vote sub-state, helpers) · `create.ts` (`createGame` lineup validation) · `votes.ts` (ballot accounting) · `resolution.ts` (death application, hunter windows, idiot flips, win checks) · `night.ts` (wolf kill, witch potions, seer checks) · `day.ts` (dawn announce, last words, speeches, exile votes, PK) · `sheriff.ts` (election, PK revote, badge 移交/撕毁) · `engine.ts` (the `applyAction` router) · `index.ts` (public API).
  - Tests: `src/__tests__` — `harness.ts` (shared builders: `newGame`, `baseGame`, `nightKill`, `witchTurn`, `seerTurn`, `holdElection`, `openDay`, `speechRound`, `runNight`, `voteAll`, assertion helpers) plus one suite per rule area (`engine`, `night`, `witch`, `seer`, `hunter`, `idiot`, `sheriff`, `dayflow`, `win`, `fullgame`) — 93 tests mapping one-to-one onto the spec's Engine criteria.
- `packages/server` — `@werewolf/server`, the Socket.IO room server: rooms, session tokens, phase timers, per-seat filtered views.
- `packages/web` — `@werewolf/web`, the React + Vite client: renders `PlayerView`, sends `PlayerAction`.
- `tsconfig.base.json` — shared strict compiler options, extended by every package tsconfig.
- `eslint.config.js`, `.prettierrc.json` / `.prettierignore` — shared lint and format config.
- `.github/workflows/ci.yml` — PR pipeline: `npm ci` → typecheck → lint → test → format check.
- Package `exports` point at TS source (`./src/index.ts`) and packages use `moduleResolution: bundler` — the right default for the Vitest dev loop. Cross-package import wiring and any runtime emit strategy land with the PRs that connect the packages.

## Snapshot

No sandbox snapshot captured yet. Capture one once the dev stack (room server + client with real dependencies) exists and is configured.
