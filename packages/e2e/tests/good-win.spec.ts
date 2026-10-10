import { expect, test } from '@playwright/test';

import { playScriptedGame } from './harness/driver';
import { goodWinPlan } from './harness/plans';
import { dayLogText, expectPostgameSection, revealFates } from './harness/reveal';
import { openTable, anchorPage } from './harness/table';

/** Evidence directory for game-over screenshots (CI artifact / QA upload). */
const EVIDENCE_DIR = process.env.WEREWOLF_EVIDENCE_DIR;

test('scenario B: 12 seats play to a good win through an idiot reveal and a hunter shot', async ({
  browser,
}) => {
  const table = await openTable(browser);
  try {
    const roles = new Map(table.seats.map((seat) => [seat.seat, seat.role]));
    const idiotSeat = [...roles.entries()].find(([, role]) => role === 'idiot')?.[0];
    expect(idiotSeat, 'the deal includes an idiot').toBeDefined();

    const winner = await playScriptedGame(table, goodWinPlan(roles), {
      label: 'good-win',
      evidenceDir: EVIDENCE_DIR,
    });
    expect(winner).toBe('good');

    // Every wolf is out (poison, shot, exiles); the idiot survived his exile.
    const fates = await revealFates(anchorPage(table));
    for (const [seat, role] of roles) {
      expect(fates.get(seat), `seat ${seat} (${role}) reveal row`).toBeDefined();
      if (role === 'werewolf') expect(fates.get(seat), `wolf seat ${seat}`).toBe('出局');
      if (role === 'idiot') expect(fates.get(seat), `idiot seat ${seat}`).toBe('存活');
    }

    // The two scripted beats are in the public log: the day-1 exile landed on
    // the idiot (flipped, vote voided) and the hunter's shot took a wolf.
    const log = await dayLogText(anchorPage(table));
    expect(log).toContain('是白痴，失去投票权');
    expect(log).toContain('猎人开枪带走了');
    expect(log).toContain('好人阵营胜利');

    // Same 复盘 assertions as scenario A: the stats grid always, the 未配置
    // click path wherever the suite runs without an assistant provider.
    await expectPostgameSection(anchorPage(table));
  } finally {
    await table.close();
  }
});
