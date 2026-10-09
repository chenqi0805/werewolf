import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Static file handler for the built web client, mounted on the room server's
 * HTTP listener so one process serves the client and the Socket.IO endpoint
 * at a single origin. Non-asset GETs fall back to index.html (SPA routing);
 * only files under `root` are ever served — path traversal and dotfiles are
 * rejected.
 */
export function serveStatic(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const rootDir = resolve(root);
  const indexPath = join(rootDir, 'index.html');

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[werewolf] static handler failed:', error);
      if (!res.headersSent) send(res, 500, 'Internal Server Error', 'text/plain; charset=utf-8');
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://werewolf.invalid');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      send(res, 400, 'Bad Request', 'text/plain; charset=utf-8');
      return;
    }

    const file = safeJoin(pathname);
    if (file === null) {
      send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
      return;
    }

    const isFile = file !== null && (await isRegularFile(file));
    if (!isFile && hasFileExtension(pathname)) {
      // Asset-looking paths must exist; the SPA fallback is for routes only.
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return;
    }

    const body = await readFile(isFile ? file : indexPath);
    const servedPath = isFile ? file : indexPath;
    const immutable = servedPath.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type':
        CONTENT_TYPES[extname(servedPath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': body.byteLength,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** Resolves a URL pathname under the root, or null when it escapes it. */
  function safeJoin(pathname: string): string | null {
    const normalized = normalize(pathname);
    if (normalized.includes('/.')) return null;
    const candidate = resolve(rootDir, `.${normalized}`);
    return candidate === rootDir || candidate.startsWith(rootDir + sep) ? candidate : null;
  }
}

function hasFileExtension(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  return last.includes('.') && !last.endsWith('.');
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
