import type { GameEvent, Seat } from '@werewolf/engine';
import type { PlayerRow, PlayerView, StepView, YouView } from '@werewolf/server';
import { describe, expect, it, vi } from 'vitest';

import { buildPrompt, isLegalFor, LlmStrategy, parseDecision } from '../llm';
import { mulberry32, seedFromString } from '../rng';
import { recentSpeechOf, type BotContext, type BotDecision } from '../strategy';
import type { ScriptedStrategy } from '../scripted';

// — view factory — the same fog-of-war PlayerView shape the scripted suite uses —

function row(seat: Seat, overrides: Partial<PlayerRow> = {}): PlayerRow {
  return {
    seat,
    name: '',
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 1,
    occupied: true,
    isBot: false,
    botName: null,
    role: null,
    ...overrides,
  };
}

function view(opts: {
  you: YouView;
  players?: PlayerRow[];
  step: StepView;
  log?: GameEvent[];
}): PlayerView {
  return {
    phase: opts.step.kind === 'game-over' ? 'game-over' : 'speech',
    dayNumber: 1,
    winner: null,
    board: 'classic',
    you: opts.you,
    players: opts.players ?? [row(1), row(2), row(3), row(4), row(5)],
    step: opts.step,
    log: opts.log ?? [],
    timer: null,
  };
}

function you(seat: Seat, role: YouView['role'], extras: Partial<YouView> = {}): YouView {
  return {
    seat,
    role,
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 1,
    ...extras,
  };
}

const ctxOf = (v: PlayerView): BotContext => ({
  view: v,
  recentSpeech: recentSpeechOf(v),
  rng: mulberry32(seedFromString('llm-test')),
});

// — parseDecision —

describe('parseDecision', () => {
  it('parses a bare JSON object into action and speech', () => {
    const d = parseDecision(
      '{"action":{"type":"SPEAK","actor":3,"text":"我是平民"},"speech":"我是平民"}',
    );
    expect(d?.action).toEqual({ type: 'SPEAK', actor: 3, text: '我是平民' });
    expect(d?.speech).toBe('我是平民');
  });

  it('extracts JSON from fenced or prose-wrapped answers', () => {
    const fenced = '```json\n{"action":{"type":"WITCH_PASS","actor":4}}\n```';
    expect(parseDecision(fenced)?.action).toEqual({ type: 'WITCH_PASS', actor: 4 });
    const prosed = '好的，我的决定是 {"action":{"type":"SEER_PASS","actor":5}} 请看。';
    expect(parseDecision(prosed)?.action).toEqual({ type: 'SEER_PASS', actor: 5 });
  });

  it('returns null for garbage, empty shells, and missing actions', () => {
    expect(parseDecision('对不起，我不知道')).toBeNull();
    expect(parseDecision('{}')).toBeNull();
    expect(parseDecision('{"speech":"只有发言"}')).toBeNull();
    expect(parseDecision('{"action":"not an object"}')).toBeNull();
  });
});

// — isLegalFor —

describe('isLegalFor', () => {
  it('accepts the owning seat action for the open step', () => {
    const v = view({ you: you(3, 'werewolf'), step: { kind: 'night', step: 'wolf' } });
    expect(isLegalFor(v, { type: 'WOLF_KILL', actor: 3, target: 2 })).toBe(true);
  });

  it('rejects a stolen actor seat', () => {
    const v = view({ you: you(3, 'werewolf'), step: { kind: 'night', step: 'wolf' } });
    expect(isLegalFor(v, { type: 'WOLF_KILL', actor: 4, target: 2 })).toBe(false);
  });

  it('rejects actions from the wrong phase', () => {
    const vote = view({
      you: you(3, 'villager'),
      step: { kind: 'exile-vote', electorate: [1, 2, 3] },
    });
    expect(isLegalFor(vote, { type: 'WOLF_KILL', actor: 3, target: 2 })).toBe(false);
    expect(isLegalFor(vote, { type: 'SPEAK', actor: 3, text: 'hi' })).toBe(false);
    expect(isLegalFor(vote, { type: 'EXILE_VOTE', actor: 3, target: 2 })).toBe(true);
  });

  it('routes pk votes by their vote kind', () => {
    const sheriffPk = view({
      you: you(3, 'villager'),
      step: { kind: 'pk-vote', electorate: [1, 3], voteKind: 'sheriff' },
    });
    expect(isLegalFor(sheriffPk, { type: 'SHERIFF_VOTE', actor: 3, target: 1 })).toBe(true);
    expect(isLegalFor(sheriffPk, { type: 'EXILE_VOTE', actor: 3, target: 1 })).toBe(false);
  });

  it('accepts the guard actions while the night waits on him, and the wolf step still rejects them', () => {
    const guardTurn = view({
      you: you(12, 'guard'),
      step: { kind: 'night', step: 'wolf', guardPending: true },
    });
    expect(isLegalFor(guardTurn, { type: 'GUARD_PROTECT', actor: 12, target: 9 })).toBe(true);
    expect(isLegalFor(guardTurn, { type: 'GUARD_PASS', actor: 12 })).toBe(true);
    const wolfTurn = view({ you: you(3, 'werewolf'), step: { kind: 'night', step: 'wolf' } });
    expect(isLegalFor(wolfTurn, { type: 'GUARD_PROTECT', actor: 3, target: 9 })).toBe(false);
    expect(isLegalFor(wolfTurn, { type: 'GUARD_PASS', actor: 3 })).toBe(false);
  });

  it('gates interrupt windows to the seat whose window is open', () => {
    const otherShot = view({
      you: you(5, 'hunter', { hunterShotUsed: false }),
      step: { kind: 'hunter-shot', seat: 3 },
    });
    expect(isLegalFor(otherShot, { type: 'HUNTER_SHOOT', actor: 5, target: 2 })).toBe(false);
    const ownShot = view({
      you: you(3, 'hunter', { hunterShotUsed: false }),
      step: { kind: 'hunter-shot', seat: 3 },
    });
    expect(isLegalFor(ownShot, { type: 'HUNTER_SHOOT', actor: 3, target: 2 })).toBe(true);
  });

  it('accepts SPEAK in the sheriff-speech step — 警上发言 no longer degrades', () => {
    const v = view({
      you: you(3, 'seer'),
      step: { kind: 'sheriff-speech', queue: [3], cursor: 0 },
    });
    expect(isLegalFor(v, { type: 'SPEAK', actor: 3, text: '我是预言家' })).toBe(true);
    expect(isLegalFor(v, { type: 'SPEAK', actor: 4, text: '我是预言家' })).toBe(false);
  });

  it('gates WOLF_EXPLODE to living plain wolves in open windows', () => {
    const windows: StepView[] = [
      { kind: 'sheriff-signup', candidates: [] },
      { kind: 'sheriff-speech', queue: [3], cursor: 0 },
      { kind: 'speech', order: [3], cursor: 0 },
      { kind: 'pk-speech', tied: [3], cursor: 0 },
    ];
    for (const step of windows) {
      const v = view({ you: you(3, 'werewolf', { wolfPack: [3, 5] }), step });
      expect(isLegalFor(v, { type: 'WOLF_EXPLODE', actor: 3 }), `step ${step.kind}`).toBe(true);
    }
    const ballot = view({
      you: you(3, 'werewolf'),
      step: { kind: 'exile-vote', electorate: [1, 2, 3] },
    });
    expect(isLegalFor(ballot, { type: 'WOLF_EXPLODE', actor: 3 })).toBe(false);
    const king = view({
      you: you(3, 'white_wolf_king'),
      step: { kind: 'speech', order: [3], cursor: 0 },
    });
    expect(isLegalFor(king, { type: 'WOLF_EXPLODE', actor: 3 })).toBe(false);
    const villager = view({
      you: you(3, 'villager'),
      step: { kind: 'speech', order: [3], cursor: 0 },
    });
    expect(isLegalFor(villager, { type: 'WOLF_EXPLODE', actor: 3 })).toBe(false);
    const dead = view({
      you: you(3, 'werewolf', { alive: false }),
      step: { kind: 'speech', order: [3], cursor: 0 },
    });
    expect(isLegalFor(dead, { type: 'WOLF_EXPLODE', actor: 3 })).toBe(false);
  });
});

// — buildPrompt —

describe('buildPrompt', () => {
  it('carries the fog-of-war view and recent speech, nothing else', () => {
    const v = view({ you: you(3, 'witch'), step: { kind: 'night', step: 'witch' } });
    const messages = buildPrompt(ctxOf(v));
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    const user = JSON.parse(messages[1]!.content) as { view: PlayerView; recentSpeech: string[] };
    expect(user.view.you.seat).toBe(3);
    expect(user.recentSpeech).toEqual([]);
  });
});

// — LlmStrategy —

function fallbackOf(result: BotDecision | null): {
  strategy: ScriptedStrategy;
  calls: () => number;
} {
  let calls = 0;
  const strategy = {
    decide: () => {
      calls += 1;
      return Promise.resolve(result);
    },
  } as unknown as ScriptedStrategy;
  return { strategy, calls: () => calls };
}

describe('LlmStrategy', () => {
  const wolfView = view({ you: you(3, 'werewolf'), step: { kind: 'night', step: 'wolf' } });
  const legalAnswer = '{"action":{"type":"WOLF_KILL","actor":3,"target":2}}';

  it('uses a legal model answer and never touches the fallback', async () => {
    const chat = vi.fn().mockResolvedValue(legalAnswer);
    const fb = fallbackOf(null);
    const strategy = new LlmStrategy(fb.strategy, { chat });
    const d = await strategy.decide(ctxOf(wolfView));
    expect(d?.action).toEqual({ type: 'WOLF_KILL', actor: 3, target: 2 });
    expect(fb.calls()).toBe(0);
  });

  it('degrades an illegal answer (wrong actor) to the fallback', async () => {
    const chat = vi.fn().mockResolvedValue('{"action":{"type":"WOLF_KILL","actor":4,"target":2}}');
    const fb = fallbackOf({ action: { type: 'WOLF_KILL', actor: 3, target: 5 } });
    const strategy = new LlmStrategy(fb.strategy, { chat });
    expect((await strategy.decide(ctxOf(wolfView)))?.action).toEqual({
      type: 'WOLF_KILL',
      actor: 3,
      target: 5,
    });
    expect(fb.calls()).toBe(1);
  });

  it('degrades unparseable output to the fallback', async () => {
    const chat = vi.fn().mockResolvedValue('我觉得应该杀 2 号。');
    const fb = fallbackOf(null);
    const strategy = new LlmStrategy(fb.strategy, { chat });
    expect(await strategy.decide(ctxOf(wolfView))).toBeNull();
    expect(fb.calls()).toBe(1);
  });

  it('a wolf explode answer rides the wire without the fallback', async () => {
    const chat = vi.fn().mockResolvedValue('{"action":{"type":"WOLF_EXPLODE","actor":3}}');
    const fb = fallbackOf(null);
    const strategy = new LlmStrategy(fb.strategy, { chat });
    const explodeView = view({
      you: you(3, 'werewolf', { wolfPack: [3, 5] }),
      step: { kind: 'speech', order: [3], cursor: 0 },
    });
    expect((await strategy.decide(ctxOf(explodeView)))?.action).toEqual({
      type: 'WOLF_EXPLODE',
      actor: 3,
    });
    expect(fb.calls()).toBe(0);
  });

  it('degrades an endpoint failure to the fallback', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('connection refused'));
    const fb = fallbackOf({ action: { type: 'WOLF_KILL', actor: 3, target: 5 } });
    const strategy = new LlmStrategy(fb.strategy, { chat });
    expect((await strategy.decide(ctxOf(wolfView)))?.action).toEqual({
      type: 'WOLF_KILL',
      actor: 3,
      target: 5,
    });
    expect(fb.calls()).toBe(1);
  });

  it('degrades a timeout to the fallback', async () => {
    const chat = vi.fn().mockImplementation(
      (_messages: unknown, opts: { timeoutMs: number }) =>
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error('timeout')), opts.timeoutMs + 50);
        }),
    );
    const fb = fallbackOf(null);
    const strategy = new LlmStrategy(fb.strategy, { chat }, { timeoutMs: 20 });
    expect(await strategy.decide(ctxOf(wolfView))).toBeNull();
    expect(fb.calls()).toBe(1);
  });
});
