import { createApp } from './gateway';
import type { TimerOverrides } from './gateway';
import { serveStatic } from './static';

// Dev/production entry: boots the room server on one HTTP port. The Vite dev
// server proxies /socket.io here; in production the same process can serve
// the built client itself (WEREWOLF_WEB_DIST) behind one origin.
const port = Number(process.env.WEREWOLF_PORT ?? process.env.PORT ?? 3000);
const timers = parseTimers(process.env.WEREWOLF_TIMERS);
const webDist = process.env.WEREWOLF_WEB_DIST;

const app = createApp(timers === null ? undefined : { timers });
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
