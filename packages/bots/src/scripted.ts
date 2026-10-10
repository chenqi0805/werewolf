import type { Seat } from '@werewolf/engine';

import type { BotContext, BotDecision, BotStrategy } from './strategy';

/**
 * The scripted brain — deterministic heuristics, zero I/O.
 *
 * It powers every CI and e2e bot and is what a live game degrades to when a
 * model backend is unavailable, so it plays a complete game: wolves always
 * answer the kill vote (one stalled wolf would force 空刀 every night), the
 * witch saves the first knife and hoards poison, the seer checks, claims, and
 * always runs for sheriff (the only scripted candidate — her 警上发言 is a
 * fixed line), the guard alternates targets under 连守, the 白狼王 destructs
 * when the pack is down to him, and votes concentrate on the lowest living
 * seat so a table of bots converges to an end instead of abstaining forever.
 * Scripted wolves never 自爆 — exploding stays an LLM-only option.
 *
 * Target selection is a pure function of the view (+ the guard's own last
 * protection): repeated broadcasts re-offer the same opportunity and the
 * runner's fingerprint dedupe suppresses the duplicate instead of emitting
 * an oscillating stream of rejections. The seeded rng only varies speech.
 */
export class ScriptedStrategy implements BotStrategy {
  /** The guard's previous night's protection — the 连守 check needs it. */
  private lastProtected: Seat | null = null;

  async decide(ctx: BotContext): Promise<BotDecision | null> {
    const { view } = ctx;
    const you = view.you;
    // Spectators and the pre-game lobby owe nothing.
    if (you.seat === null || you.role === null) return null;
    const actor = you.seat;

    switch (view.step.kind) {
      case 'night':
        return this.nightDecision(view, actor);
      case 'hunter-shot':
        return this.interruptDecision(view, actor);
      case 'exile-vote':
        return this.ballot(view, actor);
      case 'pk-vote':
        // A sheriff PK revote is the 警下 ballot for the badge — the same
        // candidate-reading rule as the first ballot, never a fellow elector.
        return view.step.voteKind === 'sheriff'
          ? this.sheriffBallot(view, actor)
          : this.ballot(view, actor);
      case 'sheriff-vote':
        return this.sheriffBallot(view, actor);
      case 'sheriff-signup':
        return this.sheriffSignupDecision(view, actor);
      case 'sheriff-speech':
        return this.sheriffSpeechDecision(ctx, actor);
      case 'badge-pass':
        return this.badgePassDecision(view, actor);
      case 'speech':
        return this.speechDecision(ctx, actor) ?? this.kingDestructDecision(view, actor);
      case 'last-words': {
        // Last words are spoken by the dead — the slot is the entitlement.
        if (!holdsQueueSlot(view.step, actor)) return null;
        return { action: { type: 'SPEAK', actor, text: lastWordsFor(ctx) } };
      }
      default:
        return null;
    }
  }

  private nightDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const you = view.you;
    if (!you.alive) return null;
    switch (you.role) {
      case 'guard':
        return this.guardDecision(view, actor);
      case 'werewolf':
      case 'white_wolf_king':
        return this.wolfDecision(view, actor);
      case 'witch':
        return this.witchDecision(view, actor);
      case 'seer':
        return this.seerDecision(view, actor);
      default:
        return null;
    }
  }

  /** Protect the lowest other living seat, alternating under 连守; 自守 when boxed in. */
  private guardDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const candidates = livingSeats(view).filter((s) => s !== actor && s !== this.lastProtected);
    if (candidates.length === 0) {
      return { action: { type: 'GUARD_PROTECT', actor, target: actor } };
    }
    const target = lowestSeat(candidates);
    this.lastProtected = target;
    return { action: { type: 'GUARD_PROTECT', actor, target } };
  }

  /**
   * The pack always answers the knife. Every wolf computes the same target
   * from the same fog-of-war — the lowest living non-pack seat — so the pack
   * never splits its vote into 空刀, and when nothing valid remains it votes
   * the explicit 空刀 rather than stalling the night.
   */
  private wolfDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const pack = view.you.wolfPack ?? [actor];
    const target = lowestOf(livingSeats(view).filter((s) => !pack.includes(s)));
    return { action: { type: 'WOLF_KILL', actor, target } };
  }

  /** Save the first knife with the heal; the poison is hoarded forever. */
  private witchDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const potions = view.you.witchPotions;
    if (potions === undefined) return null;
    // killTarget rides the view only while her own night step is open; a
    // wolf-sub-step broadcast omits it. Deciding there emitted a stale
    // WITCH_PASS that could land after her step opened and burn the turn
    // the heal needed — decline and let the step's own view re-ask.
    if (potions.killTarget === undefined) return null;
    const savesFirstKnife = view.dayNumber === 1 && !potions.healUsed && potions.killTarget !== null;
    if (savesFirstKnife) return { action: { type: 'WITCH_HEAL', actor } };
    return { action: { type: 'WITCH_PASS', actor } };
  }

  /** Check the lowest unchecked living seat; pass once everything is seen. */
  private seerDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const checks = view.you.seerChecks ?? {};
    const unchecked = livingSeats(view).filter((s) => s !== actor && !(s in checks));
    if (unchecked.length === 0) return { action: { type: 'SEER_PASS', actor } };
    return { action: { type: 'SEER_CHECK', actor, target: lowestSeat(unchecked) } };
  }

  /**
   * The shared settlement window: a hunter shoots the lowest living seat,
   * and the 白狼王 destructs — preferring the badge holder, else the lowest.
   * Both windows open at the actor's death (a dying hunter's shot, a dead
   * king's own exile settlement), so the window — not liveness — is the
   * entitlement. (A poison death never opens a hunter window; the engine
   * silences that shot, so the "withhold on poison" rule is server-side.)
   */
  private interruptDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const you = view.you;
    if (view.step.kind !== 'hunter-shot' || view.step.seat !== actor) return null;
    const living = livingSeats(view).filter((s) => s !== actor);
    if (you.role === 'white_wolf_king') {
      const badge = living.find((s) => seatRow(view, s)?.hasBadge) ?? null;
      const target = badge ?? lowestOf(living);
      if (target === null) return { action: { type: 'WOLF_KING_PASS', actor } };
      return { action: { type: 'WOLF_KING_DESTRUCT', actor, target } };
    }
    if (you.role !== 'hunter' || you.hunterShotUsed) return null;
    const target = lowestOf(living);
    if (target === null) return { action: { type: 'HUNTER_PASS', actor } };
    return { action: { type: 'HUNTER_SHOOT', actor, target } };
  }

  /**
   * Mid-speech 自爆: the last living wolf ends the day while he still has
   * teeth, taking the badge holder (or the lowest seat) with him. The engine
   * opens this window to any speech moment while he lives.
   */
  private kingDestructDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const you = view.you;
    if (!you.alive || you.role !== 'white_wolf_king') return null;
    const pack = you.wolfPack ?? [actor];
    if (livingSeats(view).filter((s) => pack.includes(s)).length !== 1) return null;
    const living = livingSeats(view).filter((s) => s !== actor);
    const badge = living.find((s) => seatRow(view, s)?.hasBadge) ?? null;
    const target = badge ?? lowestOf(living);
    if (target === null) return null;
    return { action: { type: 'WOLF_KING_DESTRUCT', actor, target } };
  }

  /** Hand the badge to the lowest living seat (a wolf prefers a packmate). */
  private badgePassDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const you = view.you;
    // The window opens at the holder's death — the slot is the entitlement.
    if (view.step.kind !== 'badge-pass' || view.step.seat !== actor) return null;
    const living = livingSeats(view).filter((s) => s !== actor);
    const pack = you.wolfPack ?? [];
    const packmates = living.filter((s) => pack.includes(s));
    const target = lowestOf(packmates.length > 0 ? packmates : living);
    return { action: { type: 'SHERIFF_PASS', actor, target } };
  }

  /** Exile voters with rights vote the lowest living seat; abstain when alone. */
  private ballot(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const step = view.step;
    if (step.kind !== 'exile-vote' && step.kind !== 'pk-vote') return null;
    const you = view.you;
    if (!you.alive || !step.electorate.includes(actor)) return null;
    const target = lowestOf(step.electorate.filter((s) => s !== actor));
    return { action: { type: 'EXILE_VOTE', actor, target } };
  }

  /**
   * 竞选 is deterministic: the seer always runs (the day-1 podium is her
   * claim), every other role stays off the platform. Once standing she goes
   * quiet — a repeat signup is a guaranteed ALREADY_DONE rejection, and the
   * runner's fingerprint dedupe only suppresses identical decisions.
   */
  private sheriffSignupDecision(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const step = view.step;
    if (step.kind !== 'sheriff-signup') return null;
    const you = view.you;
    if (!you.alive || you.role !== 'seer') return null;
    if (step.candidates.includes(actor)) return null;
    return { action: { type: 'SHERIFF_SIGNUP', actor } };
  }

  /** The candidate's fixed 警上发言 — one deterministic campaign line. */
  private sheriffSpeechDecision(ctx: BotContext, actor: Seat): BotDecision | null {
    const { view } = ctx;
    if (!view.you.alive || !holdsQueueSlot(view.step, actor)) return null;
    return { action: { type: 'SPEAK', actor, text: SHERIFF_SPEECH_LINE } };
  }

  /**
   * 警下 voters back the lowest living candidate. Candidates are read from
   * the public signup log minus withdrawals — the StepView does not carry
   * the platform list, but the fog-of-war log does. A sheriff PK revote is
   * the same 警下 ballot; a fellow elector is never a legal target.
   */
  private sheriffBallot(view: PlayerViewOf, actor: Seat): BotDecision | null {
    const step = view.step;
    const you = view.you;
    if (step.kind !== 'sheriff-vote' && step.kind !== 'pk-vote') return null;
    if (step.kind === 'pk-vote' && step.voteKind !== 'sheriff') return null;
    if (!you.alive || !step.electorate.includes(actor)) return null;
    const withdrawn = new Set(
      view.log.filter((e) => e.type === 'SHERIFF_WITHDREW').map((e) => e.seat),
    );
    const candidates = view.log
      .filter((e) => e.type === 'SHERIFF_SIGNUP_MADE')
      .map((e) => e.seat)
      .filter((s) => s !== actor && !withdrawn.has(s) && (seatRow(view, s)?.alive ?? false));
    const target = lowestOf(candidates);
    return { action: { type: 'SHERIFF_VOTE', actor, target } };
  }

  /** Role-flavored deterministic speech; the rng only varies the phrasing. */
  private speechDecision(ctx: BotContext, actor: Seat): BotDecision | null {
    const { view } = ctx;
    const you = view.you;
    if (!you.alive || !holdsOrderSlot(view.step, actor)) return null;
    return { action: { type: 'SPEAK', actor, text: speechFor(ctx) } };
  }
}

// — pure view helpers (shared by the decision rules above) ——————————

type PlayerViewOf = BotContext['view'];

function livingSeats(view: PlayerViewOf): Seat[] {
  return view.players.filter((p) => p.alive).map((p) => p.seat);
}

function seatRow(view: PlayerViewOf, seat: Seat) {
  return view.players.find((p) => p.seat === seat);
}

/** Deterministic and identical across every seat's view — coordination. */
function lowestOf(seats: Seat[]): Seat | null {
  return seats.length > 0 ? Math.min(...seats) : null;
}

/** Non-empty variant — the caller's length guard makes the non-null return honest. */
function lowestSeat(seats: readonly Seat[]): Seat {
  return seats.reduce((a, b) => (b < a ? b : a));
}

function holdsOrderSlot(step: PlayerViewOf['step'], seat: Seat): boolean {
  if (step.kind !== 'speech') return false;
  return step.order !== null && step.order[step.cursor] === seat;
}

/** Queue-shaped slots (last-words, sheriff-speech) belong to queue[cursor]. */
function holdsQueueSlot(step: PlayerViewOf['step'], seat: Seat): boolean {
  if (step.kind !== 'last-words' && step.kind !== 'sheriff-speech') return false;
  return step.queue[step.cursor] === seat;
}

/** The fixed 警上发言 every scripted candidate gives — deterministic for e2e. */
const SHERIFF_SPEECH_LINE = '我是预言家，上警给大家报查验，请警下把票投给我。';

function lastWordsFor(ctx: BotContext): string {
  return ctx.rng() < 0.5 ? '祝大家好运。' : '就到这里吧。';
}

function speechFor(ctx: BotContext): string {
  const { view, rng } = ctx;
  const you = view.you;
  const say = (a: string, b: string): string => (rng() < 0.5 ? a : b);
  switch (you.role) {
    case 'seer': {
      const entries = Object.entries(you.seerChecks ?? {});
      if (entries.length === 0) return '我是预言家，还没有查验结果。';
      const [seatStr, camp] = entries[entries.length - 1] as [string, string];
      return camp === 'wolf'
        ? `我是预言家，${seatStr}号查验是狼人！`
        : `我是预言家，${seatStr}号查验是好人。`;
    }
    case 'werewolf':
    case 'white_wolf_king':
      return say('我是好人，先听大家的发言。', '我觉得大家都可以说说自己的看法。');
    case 'witch':
      return say('我是好人，今晚的药我会斟酌。', '先听发言，我保留意见。');
    case 'hunter':
      return say('我是好人，枪在谁手里不重要。', '过牌，听后续发言。');
    default:
      return say('我是普通村民，过。', '我先听大家的发言。');
  }
}
