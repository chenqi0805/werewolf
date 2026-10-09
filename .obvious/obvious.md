# werewolf

Standard 12-player 狼人杀 (Werewolf) online multiplayer — a server-authoritative TypeScript monorepo. Product spec: Obvious blueprint `art_bP1gGegs`.

## Status

Monorepo scaffold is in place: npm workspaces with three package shells (`packages/engine`, `packages/server`, `packages/web`), each with its own tsconfig, a placeholder export, and one passing Vitest test. Shared tooling: `tsconfig.base.json` (strict, ES2022), ESLint 10 flat config, Prettier, and GitHub Actions CI running typecheck + lint + test + format check on every PR and on `main` (Node 24). No game code yet — the engine, room server, and client land in their own PRs.

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

- `packages/engine` — `@werewolf/engine`, the pure rules engine. Zero I/O; will consume the typed `PlayerAction` protocol (the future AI-bot seam).
- `packages/server` — `@werewolf/server`, the Socket.IO room server: rooms, session tokens, phase timers, per-seat filtered views.
- `packages/web` — `@werewolf/web`, the React + Vite client: renders `PlayerView`, sends `PlayerAction`.
- `tsconfig.base.json` — shared strict compiler options, extended by every package tsconfig.
- `eslint.config.js`, `.prettierrc.json` / `.prettierignore` — shared lint and format config.
- `.github/workflows/ci.yml` — PR pipeline: `npm ci` → typecheck → lint → test → format check.
- Package `exports` point at TS source (`./src/index.ts`) and packages use `moduleResolution: bundler` — the right default for the Vitest dev loop. Cross-package import wiring and any runtime emit strategy land with the PRs that connect the packages.

## Snapshot

No sandbox snapshot captured yet. Capture one once the dev stack (room server + client with real dependencies) exists and is configured.
