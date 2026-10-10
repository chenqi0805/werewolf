import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Seat } from '@werewolf/engine';
import type { PlayerView } from '@werewolf/server';
import { afterAll, describe, expect, it } from 'vitest';

import { fetchLlmClient, LlmStrategy } from '../llm';
import type { ScriptedStrategy } from '../scripted';
import type { BotContext, BotDecision } from '../strategy';

// — a real loopback HTTP server standing in for llama-server's OpenAI API —
// The repo's test philosophy is real transports (the integration suite talks
// to the server over genuine sockets), so these tests exercise the actual
// fetch path — URL shape, headers, body, abort — not a stubbed global.

interface RecordedRequest {
  authorization: string | undefined;
  body: string;
}

type EndpointHandler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

const servers: Server[] = [];

async function startMockEndpoint(
  handler: EndpointHandler,
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ authorization: req.headers.authorization, body });
      handler(req, body, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests };
}

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** The exact JSON shape an OpenAI-compatible endpoint answers with. */
function openAiReply(text: string): string {
  return JSON.stringify({ choices: [{ message: { content: text } }] });
}

// — a minimal view, the same shape the llm.test.ts factories build —

function wolfKillView(seat: Seat): PlayerView {
  return {
    phase: 'night',
    dayNumber: 1,
    winner: null,
    you: {
      seat,
      role: 'werewolf',
      alive: true,
      hasBadge: false,
      revealedIdiot: false,
      voteWeight: 1,
    },
    players: [
      {
        seat,
        alive: true,
        hasBadge: false,
        revealedIdiot: false,
        voteWeight: 1,
        occupied: true,
        isBot: false,
        botName: null,
        role: 'werewolf',
      },
    ],
    step: { kind: 'night', step: 'wolf' },
    log: [],
    timer: null,
  };
}

function ctxOf(view: PlayerView): BotContext {
  return { view, recentSpeech: [], rng: () => 0.5 };
}

function fallbackReturning(decision: BotDecision | null): {
  strategy: ScriptedStrategy;
  calls: () => number;
} {
  let calls = 0;
  const strategy = {
    decide: () => {
      calls += 1;
      return Promise.resolve(decision);
    },
  } as unknown as ScriptedStrategy;
  return { strategy, calls: () => calls };
}

// — fetchLlmClient against the mock endpoint —

describe('fetchLlmClient', () => {
  it('returns the assistant text and speaks the OpenAI request shape', async () => {
    const endpoint = await startMockEndpoint((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(openAiReply('{"action":{"type":"WOLF_KILL","actor":3,"target":2}}'));
    });
    const client = fetchLlmClient(endpoint.url, 'qwen2.5-0.5b-instruct');

    const text = await client.chat([{ role: 'user', content: '视角' }], {
      maxTokens: 220,
      timeoutMs: 8000,
    });

    expect(text).toBe('{"action":{"type":"WOLF_KILL","actor":3,"target":2}}');
    expect(endpoint.requests).toHaveLength(1);
    const sent = JSON.parse(endpoint.requests[0]!.body) as {
      model: string;
      messages: unknown[];
      max_tokens: number;
    };
    expect(sent.model).toBe('qwen2.5-0.5b-instruct');
    expect(sent.messages).toEqual([{ role: 'user', content: '视角' }]);
    expect(sent.max_tokens).toBe(220);
    // No key configured locally — no authorization header.
    expect(endpoint.requests[0]!.authorization).toBeUndefined();
  });

  it('sends the bearer token only when an api key is configured', async () => {
    const endpoint = await startMockEndpoint((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(openAiReply('ok'));
    });
    const client = fetchLlmClient(endpoint.url, 'm', 'test-key');
    await client.chat([{ role: 'user', content: 'x' }], { maxTokens: 10, timeoutMs: 8000 });
    expect(endpoint.requests[0]!.authorization).toBe('Bearer test-key');
  });

  it('rejects on a non-OK status', async () => {
    const endpoint = await startMockEndpoint((_req, _body, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('model loading');
    });
    const client = fetchLlmClient(endpoint.url, 'm');
    await expect(
      client.chat([{ role: 'user', content: 'x' }], { maxTokens: 10, timeoutMs: 8000 }),
    ).rejects.toThrow('LLM endpoint returned 503');
  });

  it('rejects when the reply carries no message text', async () => {
    const endpoint = await startMockEndpoint((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[]}');
    });
    const client = fetchLlmClient(endpoint.url, 'm');
    await expect(
      client.chat([{ role: 'user', content: 'x' }], { maxTokens: 10, timeoutMs: 8000 }),
    ).rejects.toThrow('LLM endpoint returned no message text');
  });

  it('aborts when the endpoint exceeds timeoutMs', async () => {
    const endpoint = await startMockEndpoint((_req, _body, res) => {
      // Answer far later than the client's budget; the abort must not wait.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(openAiReply('too late'));
      }, 500);
    });
    const client = fetchLlmClient(endpoint.url, 'm');
    await expect(
      client.chat([{ role: 'user', content: 'x' }], { maxTokens: 10, timeoutMs: 50 }),
    ).rejects.toThrow();
  });
});

// — the full stack through LlmStrategy: real HTTP in, fallback on every
// failure mode. The strategy-level branches (illegal action, wrong actor,
// timeout) are covered in llm.test.ts with an injected client; these prove
// the production fetch client degrades identically. —

describe('LlmStrategy over the real fetch client', () => {
  it('plays a legal model answer end to end', async () => {
    const endpoint = await startMockEndpoint((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(openAiReply('{"action":{"type":"WOLF_KILL","actor":3,"target":2}}'));
    });
    const fb = fallbackReturning({ action: { type: 'WOLF_KILL', actor: 3, target: 1 } });
    const strategy = new LlmStrategy(fb.strategy, fetchLlmClient(endpoint.url, 'm'));

    const decision = await strategy.decide(ctxOf(wolfKillView(3)));

    expect(decision?.action).toEqual({ type: 'WOLF_KILL', actor: 3, target: 2 });
    expect(fb.calls()).toBe(0);
  });

  it('degrades malformed model prose to the fallback', async () => {
    const endpoint = await startMockEndpoint((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(openAiReply('我觉得应该刀 2 号。'));
    });
    const fb = fallbackReturning({ action: { type: 'WOLF_KILL', actor: 3, target: 1 } });
    const strategy = new LlmStrategy(fb.strategy, fetchLlmClient(endpoint.url, 'm'));

    const decision = await strategy.decide(ctxOf(wolfKillView(3)));

    expect(decision?.action).toEqual({ type: 'WOLF_KILL', actor: 3, target: 1 });
    expect(fb.calls()).toBe(1);
  });

  it('degrades an unreachable endpoint to the fallback', async () => {
    // Port 1 on loopback is never listening — instant connection refused.
    const fb = fallbackReturning({ action: { type: 'WOLF_KILL', actor: 3, target: 1 } });
    const strategy = new LlmStrategy(fb.strategy, fetchLlmClient('http://127.0.0.1:1/v1', 'm'));

    const decision = await strategy.decide(ctxOf(wolfKillView(3)));

    expect(decision?.action).toEqual({ type: 'WOLF_KILL', actor: 3, target: 1 });
    expect(fb.calls()).toBe(1);
  });
});
