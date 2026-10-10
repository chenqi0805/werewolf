import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { corsPolicyFor, createApp, type AppOptions } from '../index';

/**
 * F6 regression: the Socket.IO CORS policy. The client authenticates with a
 * session token in the handshake payload — no cookies — so credentials are
 * never allowed. With a public base URL configured, preflights must answer
 * that origin only: a cross-origin handshake from any other origin then
 * fails in the browser, because the answered origin mismatches the
 * requester. The live cases run over a real HTTP listener and assert the
 * headers the browser enforces, not the config that produces them.
 */

const ALLOWED = 'https://game.example';
const EVIL = 'https://evil.example';

/** Boot an app on a loopback port, fire one preflight, tear it down. */
async function preflight(opts: AppOptions, origin: string): Promise<Response> {
  const app = createApp(opts);
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (app.httpServer.address() as AddressInfo).port;
    return await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });
  } finally {
    await app.close();
  }
}

describe('corsPolicyFor', () => {
  it('allows only the configured origin and never credentials', () => {
    expect(corsPolicyFor(ALLOWED)).toEqual({ origin: ALLOWED, credentials: false });
  });

  it('normalizes the configured URL to its bare origin', () => {
    expect(corsPolicyFor(`${ALLOWED}/`)).toEqual({ origin: ALLOWED, credentials: false });
    expect(corsPolicyFor(`${ALLOWED}/lan`)).toEqual({ origin: ALLOWED, credentials: false });
  });

  it('keeps the permissive origin echo when unset (localhost/dev)', () => {
    expect(corsPolicyFor(undefined)).toEqual({ origin: true, credentials: false });
    expect(corsPolicyFor('')).toEqual({ origin: true, credentials: false });
  });
});

describe('socket.io cors over a real listener', () => {
  it('answers a cross-origin preflight with the configured origin only', async () => {
    const res = await preflight({ publicBaseUrl: ALLOWED }, EVIL);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('serves the configured origin itself normally', async () => {
    const res = await preflight({ publicBaseUrl: ALLOWED }, ALLOWED);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('keeps the dev default: permissive echo, still no credentials', async () => {
    const res = await preflight({}, 'http://localhost:5173');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
