import { expect, test } from '@playwright/test';

import { playScriptedGame } from './harness/driver';
import { electionPlan } from './harness/plans';
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
