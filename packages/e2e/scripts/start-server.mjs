// Playwright webServer runner: boots the room server from the repo root with
// e2e pacing (WEREWOLF_E2E_TIMERS) and the built client mounted at one origin
// (WEREWOLF_WEB_DIST). Spawned from packages/e2e, so the workspace root is
// resolved from this file's location, not the caller's cwd.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <root>/packages/e2e/scripts → three levels up is the repo root.
const root = path.resolve(here, '..', '..', '..');
const port = process.env.WEREWOLF_E2E_PORT ?? '3100';

const child = spawn('npm', ['run', 'start', '-w', '@werewolf/server'], {
  cwd: root,
  env: {
    ...process.env,
    WEREWOLF_PORT: port,
    // Compact clocks so a full 12-seat game plays out in minutes. `speech`
    // gets the wider 3s slot: the composer auto-submits 1s before the slot
    // deadline, so the capture window is clock − 1s, and the fake-media voice
    // scenario needs room for real MediaRecorder frames (250ms cadence) to
    // relay before the transcript lands. The driver-driven scenarios never
    // feel the difference — their slots close early on the driver's SPEAK,
    // not at expiry.
    WEREWOLF_TIMERS:
      process.env.WEREWOLF_E2E_TIMERS ??
      JSON.stringify({
        'night:wolf': 5000,
        'night:witch': 5000,
        'night:seer': 5000,
        'sheriff-signup': 3000,
        'sheriff-speech': 2000,
        'sheriff-vote': 3000,
        'dawn-announce': 2000,
        'last-words': 2000,
        speech: 3000,
        'exile-vote': 5000,
        'pk-speech': 2000,
        'pk-vote': 3000,
        'hunter-shot': 5000,
        'badge-pass': 3000,
      }),
    WEREWOLF_WEB_DIST: path.resolve(root, 'packages/web/dist'),
    // Relaxed room-API bounds (WEREWOLF_LIMITS): the six-scenario suite
    // creates ~6 rooms and seats them with 12 joins each, all from one
    // 127.0.0.1 IP — far over the default per-IP create/join budgets. The
    // test server must never rate-limit itself; the wide TTL keeps no
    // scenario's room from aging out mid-run.
    WEREWOLF_LIMITS:
      process.env.WEREWOLF_E2E_LIMITS ??
      JSON.stringify({
        createPerWindow: 1000,
        joinPerWindow: 1000,
        windowMs: 600000,
        maxLiveRooms: 1000,
        emptyLobbyTtlMs: 3600000,
      }),
    // The e2e suite asserts the lobby's invite affordance is hidden, so the
    // boot is pinned provider-free regardless of the invoking shell's env
    // (parseInviteEnv: an empty key reads as unconfigured).
    RESEND_API_KEY: '',
    WEREWOLF_PUBLIC_BASE_URL: '',
  },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
