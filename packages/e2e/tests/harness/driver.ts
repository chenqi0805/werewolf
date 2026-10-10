import { expect, type Locator, type Page } from '@playwright/test';
import type { Seat } from '@werewolf/engine';

import { SELECTORS, WINNER_LABELS, dayOfTitle, seatOfChipLabel } from './labels';
import { ballotKindViaSocket, speakViaSocket } from './speechSocket';
import type { SeatPage, Table } from './table';

/** The witch's turn: heal tonight's victim, poison someone, or pass. */
export type WitchIntent = { kind: 'heal' } | { kind: 'poison'; target: number } | { kind: 'pass' };

/**
 * A scripted game plan: pure per-scenario decisions over what each pad offers.
 * Target lists come from the live seat pickers, so a plan can never pick a
 * dead or ineligible seat — it chooses among visible chips only.
 */
export interface PlayPlan {
  /** The pack's kill for this night; null = 空刀. */
  wolfKill(day: number, targets: number[]): number | null;
  witch(day: number, victim: number | null, targets: number[]): WitchIntent;
  seerCheck(day: number, targets: number[]): number;
  /** Seats that 上警 on day 1. */
  sheriffCandidates: readonly Seat[];
  /** The sheriff ballot for an elector; null = 弃票. Defaults to the exile ballot's answer. */
  sheriffVote?(seat: Seat, day: number, candidates: number[]): number | null;
  /** Text posted when the seat's speech slot opens. */
  speech(seat: Seat, day: number): string;
  /** Exile ballot for a voter; null = 弃票. */
  exileVote(seat: Seat, day: number, candidates: number[]): number | null;
  /** The hunter's shot; null = 放弃开枪. */
  hunterShot(day: number, targets: number[]): number | null;
  /** Badge handoff; null = 撕毁警徽. */
  badgePass(day: number, targets: number[]): number | null;
  /** The guard's protection; null = 空守. `banned` is the repeat-banned seat (连守). */
  guardProtect?(day: number, targets: number[], banned: number | null): number | null;
  /** The 白狼王's destruct target; null = holds fire. */
  destruct?(day: number, targets: number[]): number | null;
  /** True when this wolf 自爆s in the window open on this day — an irreversible confirm flow. */
  explode?(day: number, seat: Seat): boolean;
}

export interface PlayOptions {
  /** Scenario name for evidence screenshots (game-over reveal per seat). */
  label?: string;
  /** Directory for screenshots; capture is skipped when unset. */
  evidenceDir?: string;
  /** Driver budget; defaults from the deployment mode. */
  budgetMs?: number;
}

const TICK_MS = 300;

/**
 * Plays one full scripted game: polls every seat's page, executes the plan
 * whenever that seat's action pad is open, and stops at the game-over reveal.
 * Speech slots, dawn announcements, and last words close through the server's
 * phase clocks — the plan only ever acts where a human could.
 */
export async function playScriptedGame(
  table: Table,
  plan: PlayPlan,
  opts: PlayOptions = {},
): Promise<'wolves' | 'good'> {
  const budgetMs = opts.budgetMs ?? (process.env.WEREWOLF_BASE_URL ? 840_000 : 360_000);
  // Monotonic clock: wall time (Date.now) jumps across host suspend/resume and
  // false-fires the watchdog; hrtime freezes with the suspended process, like
  // every other timer in the stack.
  const elapsedMs = () => Number(process.hrtime.bigint() / 1_000_000n);
  const startedMs = elapsedMs();
  const deadline = startedMs + budgetMs;
  const acted = new Set<string>();

  while (elapsedMs() < deadline) {
    const winner = await readWinner(table.seats[0]?.page ?? null);
    if (winner !== null) {
      await expectReveal(table);
      await captureEvidence(table, opts, winner);
      return winner;
    }
    for (const seat of table.seats) {
      await driveSeat(seat, plan, acted);
    }
    const pace = table.seats[0]?.page;
    if (pace) await pace.waitForTimeout(TICK_MS);
  }
  throw new Error(`scripted game “${opts.label ?? '?'}” did not finish within ${budgetMs}ms`);
}

// — per-seat driving ————————————————————————————————————————————————————————

async function driveSeat(seat: SeatPage, plan: PlayPlan, acted: Set<string>): Promise<void> {
  const day = await dayNumberOf(seat.page);
  if (day === null) return;

  if (await driveWolf(seat, plan, acted, day)) return;
  if (await driveGuard(seat, plan, acted, day)) return;
  if (await driveWitch(seat, plan, acted, day)) return;
  if (await driveSeer(seat, plan, acted, day)) return;
  // Explode sits ahead of signup: the signup driver claims every seat the
  // moment the 上警 button is up, which would mask the wolf's window for the
  // whole signup phase — the sharpest 自爆 beat there is.
  if (await driveExplode(seat, plan, acted, day)) return;
  if (await driveSignup(seat, plan, acted, day)) return;
  if (await driveDirection(seat, acted, day)) return;
  // Destruct sits ahead of the speech driver: the speech panel returns true
  // even when the slot belongs to someone else, which would mask the living
  // king's window for the whole phase.
  if (await driveDestruct(seat, plan, acted, day)) return;
  if (await driveSpeech(seat, plan, acted, day)) return;
  if (await driveVote(seat, plan, acted, day)) return;
  if (await driveShot(seat, plan, acted, day)) return;
  await driveBadgePass(seat, plan, acted, day);
}

/** Wolf pad: pick the pack's victim and confirm, or pass the knife (空刀). */
async function driveWolf(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const pad = seat.page.locator(SELECTORS.wolfPad);
  if (!(await pad.isVisible())) return false;
  const fingerprint = `wolf|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const target = plan.wolfKill(day, await pickerTargets(pad));
  if (target === null) {
    if (await softClick(pad.locator('button', { hasText: '空刀' }))) acted.add(fingerprint);
    return true;
  }
  if (!(await softClick(chipFor(pad, target)))) return true;
  if (await softClick(pad.locator('button', { hasText: '确认猎杀' }))) acted.add(fingerprint);
  return true;
}

/**
 * Guard pad: protect the plan's pick (self via the 自守 toggle), or 空守.
 * The repeat-banned chip renders disabled — it still lists as a target, so
 * the plan sees it through `banned` and must choose around it.
 */
async function driveGuard(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const pad = seat.page.locator(SELECTORS.guardPad);
  if (!(await pad.isVisible())) return false;
  const fingerprint = `guard|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const targets = await pickerTargets(pad);
  const bannedChips = await pad.locator('button[aria-pressed][disabled]').all();
  const banned = bannedChips.length
    ? (seatOfChipLabel((await bannedChips[0]?.getAttribute('aria-label')) ?? null) ?? null)
    : null;

  const target = plan.guardProtect?.(day, targets, banned) ?? null;
  let done: boolean;
  if (target === null) {
    done = await softClick(pad.locator('button', { hasText: '空守' }));
  } else if (target === seat.seat) {
    await softClick(pad.locator('button', { hasText: '自守' }));
    done = await softClick(pad.locator('button', { hasText: '守护' }));
  } else {
    if (!(await softClick(chipFor(pad, target)))) return true;
    done = await softClick(pad.locator('button', { hasText: '守护' }));
  }
  if (done) acted.add(fingerprint);
  return true;
}

/** Witch pad: heal, poison, or skip — plan's call, potions permitting. */
async function driveWitch(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const pad = seat.page.locator(SELECTORS.witchPad);
  if (!(await pad.isVisible())) return false;
  const fingerprint = `witch|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const intent = plan.witch(day, await witchVictim(pad), await pickerTargets(pad));
  let done: boolean;
  if (intent.kind === 'pass') {
    done = await softClick(pad.locator('button', { hasText: '今晚不用药' }));
  } else if (intent.kind === 'heal') {
    // The heal button names its victim when there is one to save.
    done = await softClick(pad.locator('button', { hasText: /救活|使用解药/ }));
  } else {
    if (!(await softClick(chipFor(pad, intent.target)))) return true;
    done = await softClick(pad.locator('button', { hasText: '毒杀' }));
  }
  if (done) acted.add(fingerprint);
  return true;
}

async function driveSeer(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const pad = seat.page.locator(SELECTORS.seerPad);
  if (!(await pad.isVisible())) return false;
  const fingerprint = `seer|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const target = plan.seerCheck(day, await pickerTargets(pad));
  if (!(await softClick(chipFor(pad, target)))) return true;
  if (await softClick(pad.locator('button', { hasText: '查验' }))) acted.add(fingerprint);
  return true;
}

/** Sheriff signup: only plan candidates 上警, once. */
async function driveSignup(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const button = seat.page.locator(SELECTORS.signupButton);
  if (!(await button.isVisible())) return false;
  if (!plan.sheriffCandidates.includes(seat.seat)) return true;
  const fingerprint = `signup|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;
  if (await softClick(button)) acted.add(fingerprint);
  return true;
}

/** A living sheriff sets the day's speech direction before the first slot. */
async function driveDirection(seat: SeatPage, acted: Set<string>, day: number): Promise<boolean> {
  const button = seat.page.locator('button', { hasText: '顺序发言' });
  if (!(await button.isVisible())) return false;
  const fingerprint = `dir|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;
  if (await softClick(button)) acted.add(fingerprint);
  return true;
}

/** Speech panel: the plan's line leaves through the seat's own socket. */
async function driveSpeech(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const panel = seat.page.locator(SELECTORS.speechPanel);
  if (!(await panel.isVisible())) return false;
  const fingerprint = `speak|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;
  // Voice-only composer: nothing to type. The line rides the seat's socket
  // when the seat's own filtered view says the slot is theirs.
  if (await speakViaSocket(seat.seat, seat.page, plan.speech(seat.seat, day))) {
    acted.add(fingerprint);
  }
  return true;
}

/** Exile ballot: vote the plan's target or 弃票 — enabled only for electors. */
async function driveVote(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const pad = seat.page.locator(SELECTORS.votePad);
  if (!(await pad.isVisible())) return false;
  const abstain = pad.locator('button', { hasText: '弃票' });
  if (!(await abstain.isVisible())) return true; // the no-vote-rights block, not a ballot

  // The pad renders identically for both ballots — the kind only swaps the
  // wire action — so the seat's own filtered view says which ballot this is.
  const ballot = await ballotKindViaSocket(seat.seat, seat.page);
  if (ballot === null) return true; // view not landed yet — retried next tick

  const candidates = await pickerTargets(pad);
  // Fingerprint includes the ballot kind and the candidate set: a PK revote
  // the same day offers fewer chips and is a fresh ballot.
  const fingerprint = `vote|${ballot}|${seat.seat}|${day}|${candidates.join(',')}`;
  if (acted.has(fingerprint)) return true;

  const decide = ballot === 'sheriff' ? (plan.sheriffVote ?? plan.exileVote) : plan.exileVote;
  const target = decide(seat.seat, day, candidates);
  let done: boolean;
  if (target === null) {
    done = await softClick(abstain);
  } else {
    if (!(await softClick(chipFor(pad, target)))) return true;
    done = await softClick(pad.locator('button', { hasText: '放逐' }));
  }
  if (done) acted.add(fingerprint);
  return true;
}

/** Hunter window: the shot fires the moment a target chip is clicked. */
async function driveShot(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const prompt = seat.page.locator(SELECTORS.hunterShotPrompt);
  if (!(await prompt.isVisible())) return false;
  const fingerprint = `shot|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const target = plan.hunterShot(day, await pickerTargets(seat.page));
  const done =
    target === null
      ? await softClick(seat.page.locator(SELECTORS.hunterPassButton))
      : await softClick(chipFor(seat.page, target));
  if (done) acted.add(fingerprint);
  return true;
}

/** Badge handoff: name a successor or destroy the badge. */
async function driveBadgePass(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const prompt = seat.page.locator(SELECTORS.badgePassPrompt);
  if (!(await prompt.isVisible())) return false;
  const fingerprint = `badge|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const target = plan.badgePass(day, await pickerTargets(seat.page));
  const done =
    target === null
      ? await softClick(seat.page.locator(SELECTORS.badgeDestroyButton))
      : await softClick(chipFor(seat.page, target));
  if (done) acted.add(fingerprint);
  return true;
}

/**
 * 白狼王 destruct: arm the flow, then pick and confirm on a later tick.
 * The fingerprint lands only on confirm (or cancel) so a lost chip click
 * retries the open flow instead of stalling it armed.
 */
async function driveDestruct(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const section = seat.page.locator(SELECTORS.destructControl);
  if (!(await section.isVisible())) return false;
  const fingerprint = `destruct|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const arm = section.locator('button:text-is("自爆")');
  if (await arm.count()) {
    await softClick(arm);
    return true;
  }
  const target = plan.destruct?.(day, await pickerTargets(section)) ?? null;
  if (target === null) {
    if (await softClick(section.locator('button', { hasText: '取消' }))) acted.add(fingerprint);
    return true;
  }
  if (!(await softClick(chipFor(section, target)))) return true;
  if (await softClick(section.locator('button', { hasText: '确认自爆并带走' }))) {
    acted.add(fingerprint);
  }
  return true;
}

/**
 * Plain-wolf 自爆: arm the flow, then confirm on a later tick — the control
 * mirrors the 白狼王's two-step destruct minus the target pick. A wolf the
 * plan tells to hold fire returns false so the drivers below it (signup,
 * speech) still run: its control being visible must not mask the seat's
 * other windows.
 */
async function driveExplode(
  seat: SeatPage,
  plan: PlayPlan,
  acted: Set<string>,
  day: number,
): Promise<boolean> {
  const section = seat.page.locator(SELECTORS.explodeControl);
  if (!(await section.isVisible())) return false;
  if (!plan.explode?.(day, seat.seat)) return false;
  const fingerprint = `explode|${seat.seat}|${day}`;
  if (acted.has(fingerprint)) return true;

  const arm = section.locator('button:text-is("自爆")');
  if (await arm.count()) {
    await softClick(arm);
    return true;
  }
  if (await softClick(section.locator('button', { hasText: '确认自爆' }))) {
    acted.add(fingerprint);
  }
  return true;
}

// — page probes and helpers —————————————————————————————————————————————————

/** Seat numbers offered by a pad's seat picker, ascending. */
async function pickerTargets(scope: Locator | Page): Promise<number[]> {
  const chips = await scope.locator(`${SELECTORS.seatPickerGroup} button[aria-pressed]`).all();
  const seats: number[] = [];
  for (const chip of chips) {
    const seat = seatOfChipLabel(await chip.getAttribute('aria-label'));
    if (seat !== null) seats.push(seat);
  }
  return seats.sort((a, b) => a - b);
}

/** The picker chip for a seat (`aria-label` starts with “N号”). */
function chipFor(scope: Locator | Page, seat: number): Locator {
  return scope.locator(`${SELECTORS.seatPickerGroup} button[aria-label^="${seat}号"]`);
}

/** `今晚倒牌：N号` → N, or null on a 空刀 night (or if the pad vanishes mid-read — retried next tick). */
async function witchVictim(pad: Locator): Promise<number | null> {
  let text: string;
  try {
    text = (await pad.locator('p').first().textContent({ timeout: 2_000 })) ?? '';
  } catch {
    return null; // pad unmounted between probe and read — same race softClick tolerates
  }
  const match = text.match(/今晚倒牌：(\d+)号/u);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

/**
 * Click that tolerates the table moving on: with 12 concurrent drivers the
 * step may resolve between probe and click. A lost race is logged and the
 * fingerprint stays unset, so a pad that is genuinely still open is retried
 * on the next tick rather than the error being swallowed.
 */
async function softClick(target: Locator): Promise<boolean> {
  try {
    await target.click({ timeout: 1_500 });
    return true;
  } catch (error) {
    console.log(`[driver] click missed: ${describe(error)}`);
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
}

/** Day number from the game screen title; null off the game screen (title may swap mid-read). */
async function dayNumberOf(page: Page): Promise<number | null> {
  const title = page.locator('.scr-title').first();
  try {
    return dayOfTitle(await title.textContent({ timeout: 2_000 }));
  } catch {
    return null; // screen swapped (e.g. game-over) between count and read
  }
}

/** Winner once seat 1's page shows the reveal; null while the game runs. */
async function readWinner(page: Page | null): Promise<'wolves' | 'good' | null> {
  if (page === null) return null;
  const reveal = page.locator(SELECTORS.gameOver);
  if (!(await reveal.isVisible())) return null;
  try {
    const text = (await reveal.textContent({ timeout: 2_000 })) ?? '';
    for (const [label, side] of Object.entries(WINNER_LABELS)) {
      if (text.includes(label)) return side;
    }
  } catch {
    // section vanished between isVisible and read — not the winner yet; retried next tick
  }
  return null;
}

/** All twelve pages must show the reveal before the scenario may assert. */
async function expectReveal(table: Table): Promise<void> {
  await Promise.all(
    table.seats.map((seat) => expect(seat.page.locator(SELECTORS.gameOver)).toBeVisible()),
  );
}

/** Game-over screenshots (reveal + day log) for the evidence record. */
async function captureEvidence(
  table: Table,
  opts: PlayOptions,
  winner: 'wolves' | 'good',
): Promise<void> {
  if (!opts.evidenceDir || !opts.label) return;
  for (const seat of table.seats) {
    await seat.page.screenshot({
      path: `${opts.evidenceDir}/${opts.label}-gameover-seat${seat.seat}-${winner}.png`,
      fullPage: true,
    });
  }
}
