import { expect, test } from '@playwright/test';

import { playScriptedGame } from './harness/driver';
import { electionPlan, explodePlan } from './harness/plans';
import { dayLogText, expectPostgameSection, revealFates } from './harness/reveal';
import { anchorPage, openTable } from './harness/table';

/** Evidence directory for game-over screenshots (CI artifact / QA upload). */
const EVIDENCE_DIR = process.env.WEREWOLF_EVIDENCE_DIR;

test('scenario E: the seer is elected sheriff — 警上发言, 警下 ballot, and a 1.5-weight tally', async ({
  browser,
}) => {
  // One human host + eleven scripted brains; bot elections run long.
  test.setTimeout(540_000);
  const table = await openTable(browser, { humans: 1 });
  try {
    const roles = new Map(table.seats.map((seat) => [seat.seat, seat.role]));
    const seer = [...roles.entries()].find(([, role]) => role === 'seer')?.[0];
    expect(seer, 'the classic deal includes a seer').toBeDefined();

    const winner = await playScriptedGame(table, electionPlan(roles), {
      label: 'sheriff-election',
      evidenceDir: EVIDENCE_DIR,
    });
    expect(['wolves', 'good'], 'the scripted table finishes the game').toContain(winner);

    // The public log carries the whole election: the seer 上警, the sheriff
    // ballot resolved, and the seer 当选.
    const log = await dayLogText(anchorPage(table));
    expect(log).toContain(`${seer}号上警`);
    expect(log).toContain('警长竞选开票');
    expect(log).toContain(`${seer}号当选警长`);

    // The 复盘 grid's 得票 column sums the public exile tallies: every
    // ordinary ballot weighs 1, so a fractional total is only producible by
    // the elected sheriff's 1.5-weight vote landing in one.
    await expectPostgameSection(anchorPage(table));
    const votes = await anchorPage(table)
      .locator('section[aria-label="全场数据"] tbody tr td:nth-child(6)')
      .allTextContents();
    expect(
      votes.some((text) => /^\d+\.5 票$/.test(text.trim())),
      `a fractional 得票 among [${votes.map((v) => v.trim()).join(', ')}]`,
    ).toBe(true);

    // Every dealt seat has a reveal row (the full table played it out).
    const fates = await revealFates(anchorPage(table));
    for (const seat of roles.keys()) {
      expect(fates.get(seat), `seat ${seat} reveal row`).toBeDefined();
    }
  } finally {
    await table.close();
  }
});

test('scenario F: a wolf 自爆s mid-election on day 1 — the election rips up, deaths release one by one, night falls', async ({
  browser,
}) => {
  const table = await openTable(browser);
  try {
    const roles = new Map(table.seats.map((seat) => [seat.seat, seat.role]));
    const villagers = [...roles.entries()]
      .filter(([, role]) => role === 'villager')
      .map(([seat]) => seat)
      .sort((a, b) => a - b);
    const wolves = [...roles.entries()]
      .filter(([, role]) => role === 'werewolf')
      .map(([seat]) => seat)
      .sort((a, b) => a - b);
    const exploder = wolves[0];
    if (exploder === undefined || villagers.length < 2) {
      throw new Error('deal needs a plain wolf and two villagers');
    }

    const winner = await playScriptedGame(table, explodePlan(roles, 1), {
      label: 'explode-day1',
      evidenceDir: EVIDENCE_DIR,
    });
    expect(winner).toBe('wolves');

    // Day-1 ordering against the public log: 自爆 → 天亮了 → the two
    // buffered deaths one by one → night. The ripped-up election never
    // produced a sheriff line or a ballot.
    const log = await dayLogText(anchorPage(table));
    const explodeAt = log.indexOf(`${exploder}号自爆，白天结束`);
    const brokeAt = log.indexOf('天亮了');
    const night2At = log.indexOf('第 2 夜来临');
    expect(explodeAt, '自爆 line in the log').toBeGreaterThanOrEqual(0);
    expect(brokeAt, '天亮了 line in the log').toBeGreaterThanOrEqual(0);
    expect(night2At, '第 2 夜来临 line in the log').toBeGreaterThanOrEqual(0);
    expect(explodeAt, 'the blast precedes the day break').toBeLessThan(brokeAt);
    expect(brokeAt, 'night falls after the break').toBeLessThan(night2At);
    const knifeAt = log.indexOf(`${villagers[0]}号昨晚出局`);
    const poisonAt = log.indexOf(`${villagers[1]}号昨晚出局`);
    expect(knifeAt, 'first buffered death announced after the break').toBeGreaterThan(brokeAt);
    expect(poisonAt, 'second buffered death follows, one by one').toBeGreaterThan(knifeAt);
    expect(poisonAt, 'announcements finish before night').toBeLessThan(night2At);
    const day1 = log.slice(0, night2At);
    expect(day1, 'no sheriff was elected').not.toContain('当选警长');
    expect(day1, 'no ballot opened on day 1').not.toContain('放逐投票开票');

    // The blast killed the wolf — his fate is the self-destruct reveal.
    const fates = await revealFates(anchorPage(table));
    expect(fates.get(exploder), 'the exploding wolf is out').toBe('出局');
  } finally {
    await table.close();
  }
});

test('scenario G: day-2 control — a mid-speech 自爆 flows straight to night, no exile ballot', async ({
  browser,
}) => {
  const table = await openTable(browser);
  try {
    const roles = new Map(table.seats.map((seat) => [seat.seat, seat.role]));
    const exploder = [...roles.entries()]
      .filter(([, role]) => role === 'werewolf')
      .map(([seat]) => seat)
      .sort((a, b) => a - b)[0];
    if (exploder === undefined) throw new Error('deal needs a plain wolf');

    const winner = await playScriptedGame(table, explodePlan(roles, 2), {
      label: 'explode-day2',
      evidenceDir: EVIDENCE_DIR,
    });
    expect(winner).toBe('wolves');

    // The contrast with scenario F: day 1 voided NORMALLY (本局无警长 in the
    // log) and still held its exile ballot; day 2 breaks, speeches run, and
    // the blast lands before the day's ballot can open — straight to night.
    const log = await dayLogText(anchorPage(table));
    const night2At = log.indexOf('第 2 夜来临');
    const day2BreakAt = log.indexOf('天亮了', night2At);
    const explodeAt = log.indexOf(`${exploder}号自爆，白天结束`);
    const night3At = log.indexOf('第 3 夜来临');
    expect(day2BreakAt, 'day 2 broke').toBeGreaterThan(night2At);
    expect(explodeAt, '自爆 line in the log').toBeGreaterThanOrEqual(0);
    expect(night3At, '第 3 夜来临 line in the log').toBeGreaterThanOrEqual(0);
    expect(day2BreakAt, 'the blast lands after day 2 broke').toBeLessThan(explodeAt);
    expect(explodeAt, 'night falls straight after the blast').toBeLessThan(night3At);
    expect(log, 'day 1 voided through the normal path').toContain('警长竞选流产，本局无警长');
    const day2 = log.slice(day2BreakAt, night3At);
    expect(day2, 'no exile ballot on day 2').not.toContain('放逐投票开票');
    expect(day2, 'no exile landed on day 2').not.toContain('被放逐出局');
  } finally {
    await table.close();
  }
});
