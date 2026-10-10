import type { GameEvent, Seat } from '@werewolf/engine';
import type { PlayerRow, PlayerView, StepView, YouView } from '@werewolf/server';
import { describe, expect, it } from 'vitest';

import { mulberry32, seedFromString } from '../rng';
import { recentSpeechOf } from '../strategy';
import { ScriptedStrategy } from '../scripted';

// — view factory — a fog-of-war PlayerView, hand-built per case ——————————

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

interface ViewOpts {
  phase?: PlayerView['phase'];
  dayNumber?: number;
  you: YouView;
  players?: PlayerRow[];
  step: StepView;
  log?: GameEvent[];
}

function view(opts: ViewOpts): PlayerView {
  const players = opts.players ?? [row(1), row(2), row(3), row(4), row(5)];
  return {
    phase: opts.phase ?? 'night',
    dayNumber: opts.dayNumber ?? 1,
    winner: null,
    board: 'classic',
    you: opts.you,
    players,
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

const ctxOf = (v: PlayerView, seed = 'test') => ({
  view: v,
  recentSpeech: recentSpeechOf(v),
  rng: mulberry32(seedFromString(seed)),
});

const decide = (v: PlayerView, seed = 'test') => new ScriptedStrategy().decide(ctxOf(v, seed));

// — night roles ————————————————————————————————————————————————————————————

describe('scripted strategy: night', () => {
  it('wolves always answer the kill vote on the lowest non-pack seat', async () => {
    const players = [row(1, { alive: false }), row(2), row(3), row(4, { alive: false }), row(5)];
    const wolf3 = view({
      you: you(3, 'werewolf', { wolfPack: [3, 5] }),
      players,
      step: { kind: 'night', step: 'wolf' },
    });
    const wolf5 = view({
      you: you(5, 'werewolf', { wolfPack: [3, 5] }),
      players,
      step: { kind: 'night', step: 'wolf' },
    });
    // Every living wolf computes the same target from its own view.
    expect(await decide(wolf3)).toEqual({
      action: { type: 'WOLF_KILL', actor: 3, target: 2 },
    });
    expect(await decide(wolf5)).toEqual({
      action: { type: 'WOLF_KILL', actor: 5, target: 2 },
    });
  });

  it('votes the explicit 空刀 when no valid kill target remains', async () => {
    const players = [row(2, { alive: false }), row(3), row(5)];
    const v = view({
      you: you(3, 'werewolf', { wolfPack: [3, 5] }),
      players,
      step: { kind: 'night', step: 'wolf' },
    });
    expect(await decide(v)).toEqual({
      action: { type: 'WOLF_KILL', actor: 3, target: null },
    });
  });

  it('witch saves the first knife, then passes and hoards poison', async () => {
    const potions = { healUsed: false, poisonUsed: false, killTarget: 4 as Seat | null };
    const night1 = view({
      dayNumber: 1,
      you: you(5, 'witch', { witchPotions: { ...potions } }),
      step: { kind: 'night', step: 'witch' },
    });
    expect(await decide(night1)).toEqual({ action: { type: 'WITCH_HEAL', actor: 5 } });

    // Heal already spent on night 1 — every later night is a pass.
    const healed = view({
      dayNumber: 2,
      you: you(5, 'witch', { witchPotions: { ...potions, healUsed: true, killTarget: 2 } }),
      step: { kind: 'night', step: 'witch' },
    });
    expect(await decide(healed)).toEqual({ action: { type: 'WITCH_PASS', actor: 5 } });

    // A later-night knife is not saved — poison stays hoarded.
    const night2 = view({
      dayNumber: 2,
      you: you(5, 'witch', { witchPotions: { ...potions, killTarget: 2 } }),
      step: { kind: 'night', step: 'witch' },
    });
    expect(await decide(night2)).toEqual({ action: { type: 'WITCH_PASS', actor: 5 } });
  });

  it('seer checks the lowest unchecked seat and passes once all are seen', async () => {
    const base = { you: you(3, 'seer'), step: { kind: 'night', step: 'seer' } as const };
    const first = view({ ...base, players: [row(1, { alive: false }), row(2), row(3), row(4)] });
    expect(await decide(first)).toEqual({
      action: { type: 'SEER_CHECK', actor: 3, target: 2 },
    });

    const second = view({
      ...base,
      players: [row(1, { alive: false }), row(2), row(3), row(4)],
      you: you(3, 'seer', { seerChecks: { 2: 'good' } }),
    });
    expect(await decide(second)).toEqual({
      action: { type: 'SEER_CHECK', actor: 3, target: 4 },
    });

    const done = view({
      ...base,
      players: [row(1, { alive: false }), row(2), row(3), row(4, { alive: false })],
      you: you(3, 'seer', { seerChecks: { 2: 'good' } }),
    });
    expect(await decide(done)).toEqual({ action: { type: 'SEER_PASS', actor: 3 } });
  });

  it('guard alternates targets under 连守 and self-protects when boxed in', async () => {
    const guard = new ScriptedStrategy();
    const players = [row(1), row(2), row(3)];
    const make = (y: YouView) => view({ you: y, players, step: { kind: 'night', step: 'wolf' } });

    // Night 1: lowest living seat.
    const night1 = await guard.decide(ctxOf(make(you(1, 'guard')), 'g1'));
    expect(night1).toEqual({ action: { type: 'GUARD_PROTECT', actor: 1, target: 2 } });

    // Night 2: 2 is banned by 连守 → next lowest.
    const night2 = await guard.decide(ctxOf(make(you(1, 'guard')), 'g2'));
    expect(night2).toEqual({ action: { type: 'GUARD_PROTECT', actor: 1, target: 3 } });

    // Night 3: 3 is banned, 2 unlocks again.
    const night3 = await guard.decide(ctxOf(make(you(1, 'guard')), 'g3'));
    expect(night3).toEqual({ action: { type: 'GUARD_PROTECT', actor: 1, target: 2 } });

    // Boxed in: only last night's choice remains → 自守.
    const boxed = new ScriptedStrategy();
    const solo = [row(1), row(2)];
    const first = await boxed.decide(
      ctxOf(view({ you: you(1, 'guard'), players: solo, step: { kind: 'night', step: 'wolf' } })),
    );
    expect(first).toEqual({ action: { type: 'GUARD_PROTECT', actor: 1, target: 2 } });
    const selfGuard = await boxed.decide(
      ctxOf(view({ you: you(1, 'guard'), players: solo, step: { kind: 'night', step: 'wolf' } })),
    );
    expect(selfGuard).toEqual({ action: { type: 'GUARD_PROTECT', actor: 1, target: 1 } });
  });
});

// — interrupts (hunter shot / 白狼王 destruct) ————————————————————————

describe('scripted strategy: interrupts', () => {
  it('hunter shoots the lowest living seat when the window opens', async () => {
    const v = view({
      phase: 'hunter-shot',
      players: [
        row(1, { alive: false }),
        row(2, { alive: false }),
        row(3, { alive: false }),
        row(4),
        row(5),
      ],
      you: you(4, 'hunter', { alive: false }),
      step: { kind: 'hunter-shot', seat: 4 },
    });
    expect(await decide(v)).toEqual({
      action: { type: 'HUNTER_SHOOT', actor: 4, target: 5 },
    });
  });

  it('a hunter who already shot owes nothing', async () => {
    const v = view({
      phase: 'hunter-shot',
      you: you(4, 'hunter', { hunterShotUsed: true }),
      step: { kind: 'hunter-shot', seat: 4 },
    });
    expect(await decide(v)).toBeNull();
  });

  it('白狼王 destructs at his settlement window, badge holder first', async () => {
    const king = you(7, 'white_wolf_king', { alive: false, wolfPack: [2, 7] });
    const players = [
      row(2, { alive: false }),
      row(4, { hasBadge: true }),
      row(7, { alive: false, role: 'white_wolf_king' }),
      row(8),
    ];
    const withBadge = view({
      phase: 'hunter-shot',
      you: king,
      players,
      step: { kind: 'hunter-shot', seat: 7 },
    });
    expect(await decide(withBadge)).toEqual({
      action: { type: 'WOLF_KING_DESTRUCT', actor: 7, target: 4 },
    });

    const noBadge = view({
      phase: 'hunter-shot',
      you: king,
      players: [
        row(2, { alive: false }),
        row(4, { alive: false, hasBadge: true }),
        row(7, { alive: false, role: 'white_wolf_king' }),
        row(8),
      ],
      step: { kind: 'hunter-shot', seat: 7 },
    });
    expect(await decide(noBadge)).toEqual({
      action: { type: 'WOLF_KING_DESTRUCT', actor: 7, target: 8 },
    });
  });

  it('白狼王 destructs mid-speech when he is the last living wolf', async () => {
    const players = [row(2, { alive: false }), row(4), row(5), row(7, { role: 'white_wolf_king' })];
    const v = view({
      phase: 'speech',
      you: you(7, 'white_wolf_king', { wolfPack: [2, 7] }),
      players,
      step: { kind: 'speech', order: [4, 5, 7], cursor: 0 },
    });
    // Not his speech slot — the destruct is its own decision.
    expect(await decide(v)).toEqual({
      action: { type: 'WOLF_KING_DESTRUCT', actor: 7, target: 4 },
    });

    // Packmate still alive → no destruct, just (eventually) speech.
    const withPackmate = view({
      phase: 'speech',
      you: you(7, 'white_wolf_king', { wolfPack: [2, 7] }),
      players: [row(2), row(4), row(5), row(7, { role: 'white_wolf_king' })],
      step: { kind: 'speech', order: [4, 5, 7], cursor: 0 },
    });
    expect(await decide(withPackmate)).toBeNull();
  });
});

// — votes ——————————————————————————————————————————————————————————————————

describe('scripted strategy: votes', () => {
  it('concentrates the exile vote on the lowest other elector', async () => {
    const v = view({
      phase: 'exile-vote',
      you: you(4, 'villager'),
      step: { kind: 'exile-vote', electorate: [3, 4, 5] },
    });
    expect(await decide(v)).toEqual({
      action: { type: 'EXILE_VOTE', actor: 4, target: 3 },
    });
  });

  it('abstains when it is the only elector and stays silent without rights', async () => {
    const alone = view({
      phase: 'exile-vote',
      you: you(4, 'villager'),
      step: { kind: 'exile-vote', electorate: [4] },
    });
    expect(await decide(alone)).toEqual({
      action: { type: 'EXILE_VOTE', actor: 4, target: null },
    });

    const noRights = view({
      phase: 'exile-vote',
      you: you(4, 'villager', { alive: false, voteWeight: 0 }),
      step: { kind: 'exile-vote', electorate: [3, 5] },
    });
    expect(await decide(noRights)).toBeNull();
  });

  it('警下 voters back the lowest living signup from the log, withdrawals honored', async () => {
    const log: GameEvent[] = [
      { type: 'SHERIFF_SIGNUP_MADE', seat: 2 },
      { type: 'SHERIFF_SIGNUP_MADE', seat: 4 },
      { type: 'SHERIFF_WITHDREW', seat: 2 },
    ];
    const v = view({
      phase: 'sheriff-vote',
      you: you(5, 'villager'),
      step: { kind: 'sheriff-vote', electorate: [1, 3, 5] },
      log,
    });
    expect(await decide(v)).toEqual({
      action: { type: 'SHERIFF_VOTE', actor: 5, target: 4 },
    });
  });

  it('a dying wolf sheriff hands the badge to a packmate', async () => {
    const v = view({
      phase: 'hunter-shot',
      you: you(5, 'werewolf', { alive: false, hasBadge: true, wolfPack: [2, 5] }),
      players: [
        row(2, { role: 'werewolf' }),
        row(3),
        row(5, { alive: false, role: 'werewolf', hasBadge: true }),
        row(8),
      ],
      step: { kind: 'badge-pass', seat: 5 },
    });
    expect(await decide(v)).toEqual({
      action: { type: 'SHERIFF_PASS', actor: 5, target: 2 },
    });
  });
});

// — speech —————————————————————————————————————————————————————————————————

describe('scripted strategy: speech', () => {
  it('speaks only when holding the speech slot, with seeded determinism', async () => {
    const step: StepView = { kind: 'speech', order: [3, 4, 5], cursor: 1 };
    const players = [row(3), row(4), row(5)];
    const notMine = view({ phase: 'speech', you: you(3, 'villager'), players, step });
    expect(await decide(notMine)).toBeNull();

    const mine = view({ phase: 'speech', you: you(4, 'villager'), players, step });
    const one = await decide(mine, 'seed-a');
    const two = await decide(
      view({ phase: 'speech', you: you(4, 'villager'), players, step }),
      'seed-a',
    );
    expect(one).toEqual(two);
    if (one !== null && one.action.type === 'SPEAK') {
      expect(one.action.text.length).toBeGreaterThan(0);
    } else {
      expect.fail('expected a SPEAK decision');
    }
  });

  it('the seer claims her latest check in speech', async () => {
    const v = view({
      phase: 'speech',
      you: you(4, 'seer', { seerChecks: { 2: 'good', 5: 'wolf' } }),
      players: [row(2), row(4), row(5)],
      step: { kind: 'speech', order: [4, 5], cursor: 0 },
    });
    const decision = await decide(v);
    expect(decision).not.toBeNull();
    if (decision !== null && decision.action.type === 'SPEAK') {
      expect(decision.action.text).toContain('预言家');
      expect(decision.action.text).toContain('5号');
      expect(decision.action.text).toContain('狼人');
    } else {
      expect.fail('expected a SPEAK decision');
    }
  });

  it('dead players speak their last words when the queue reaches them', async () => {
    const v = view({
      phase: 'last-words',
      you: you(4, 'villager', { alive: false }),
      players: [row(3, { alive: false }), row(4, { alive: false }), row(5)],
      step: { kind: 'last-words', queue: [4], cursor: 0 },
    });
    const decision = await decide(v);
    expect(decision).not.toBeNull();
    if (decision !== null && decision.action.type === 'SPEAK') {
      expect(decision.action.actor).toBe(4);
    } else {
      expect.fail('expected a SPEAK decision');
    }
  });
});

// — the seam's pure helpers ———————————————————————————————————————————————

describe('rng and speech helpers', () => {
  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(seedFromString('ci-seed'));
    const b = mulberry32(seedFromString('ci-seed'));
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    const c = mulberry32(seedFromString('other-seed'));
    expect([c(), c(), c()]).not.toEqual(seqA);
  });

  it('recentSpeechOf takes the last N speech texts oldest first', () => {
    const log: GameEvent[] = [
      { type: 'SPEECH_MADE', seat: 1, text: 'one', context: 'speech' },
      { type: 'VOTE_TALLY', kind: 'exile', counts: [] },
      { type: 'SPEECH_MADE', seat: 2, text: 'two', context: 'speech' },
      { type: 'SPEECH_MADE', seat: 3, text: 'three', context: 'speech' },
    ];
    expect(
      recentSpeechOf(view({ you: you(1, 'villager'), step: { kind: 'lobby' }, log }), 2),
    ).toEqual(['two', 'three']);
  });
});
