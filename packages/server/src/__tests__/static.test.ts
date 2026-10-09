import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveStatic } from '../static';

/**
 * The static handler is exercised over a real HTTP listener: same-origin
 * client hosting is a deployment guarantee, not a string-matching exercise.
 */
describe('serveStatic', () => {
  let root: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'werewolf-static-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html><title>狼人杀</title>home');
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(root, 'nested', 'deep.txt'), 'deep');
    server = createServer(serveStatic(root));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function fetchPath(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${base}${path}`, init);
  }

  it('serves index.html at the root', async () => {
    const res = await fetchPath('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('狼人杀');
  });

  it('serves files with correct content types and immutable asset caching', async () => {
    const js = await fetchPath('/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');

    const txt = await fetchPath('/nested/deep.txt');
    expect(txt.status).toBe(200);
    expect(txt.headers.get('content-type')).toContain('text/plain');
    expect(txt.headers.get('cache-control')).not.toContain('immutable');
  });

  it('falls back to index.html for extensionless routes (SPA)', async () => {
    const res = await fetchPath('/some/client/route');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('狼人杀');
  });

  it('404s missing asset-looking paths instead of masking them with index.html', async () => {
    const res = await fetchPath('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it('never serves files outside the root, whatever the client normalization does', async () => {
    // A sentinel file beside (not inside) the static root: hostile paths may
    // try to reach it over raw HTTP — fetch normalizes URLs client-side and
    // would hide the attack from the server.
    const outsidePath = join(root, '..', 'werewolf-static-outside.txt');
    await writeFile(outsidePath, 'sentinel-outside-root');

    const hostile = [
      '/../werewolf-static-outside.txt',
      '/..%2Fwerewolf-static-outside.txt',
      '/%2e%2e/werewolf-static-outside.txt',
      '/assets/../../werewolf-static-outside.txt',
    ];
    for (const path of hostile) {
      const { status, body } = await rawRequest(path);
      const safe = status >= 400 || body.includes('狼人杀');
      expect(safe, `${path} → ${status} ${body.slice(0, 80)}`).toBe(true);
      expect(body, path).not.toContain('sentinel-outside-root');
    }
    await rm(outsidePath, { force: true });
  }, 15_000);

  it('rejects dotfile paths', async () => {
    await writeFile(join(root, '.env'), 'SECRET=1');
    const res = await fetchPath('/.env');
    expect(res.status).toBe(403);
  });

  it('allows only GET and HEAD', async () => {
    const post = await fetchPath('/', { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');

    const head = await fetchPath('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  /** Raw HTTP over a socket — no client-side URL normalization. */
  async function rawRequest(path: string): Promise<{ status: number; body: string }> {
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: werewolf.invalid\r\nConnection: close\r\n\r\n`);
      });
      let raw = '';
      socket.on('data', (chunk) => {
        raw += chunk.toString();
      });
      socket.on('end', () => {
        const status = Number(raw.split(' ')[1] ?? 0);
        resolve({ status, body: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
      });
      socket.on('error', reject);
    });
  }
});
