import { expect, test } from '@playwright/test';

import { playScriptedGame } from './harness/driver';
import { botMixPlan } from './harness/plans';
import { revealFates } from './harness/reveal';
import { openTable, anchorPage } from './harness/table';

test('scenario D: 5 humans + 7 scripted bots play a full game to a win', async ({ browser }) => {
  // Full mixed-table games stretch past v1's 300s under CI runner contention —
  // a fresh deal can run six-plus days at compact clocks (observed in CI).
  test.setTimeout(540_000);
  const table = await openTable(browser, { humans: 5 });
  try {
    // The bots answer every slot their brain is owed — the game must finish
    // with the humans passively speaking 过 and abstaining.
    const winner = await playScriptedGame(table, botMixPlan(), { label: 'bot-mix' });
    expect(['wolves', 'good']).toContain(winner);

    const fates = await revealFates(anchorPage(table));
    for (const seat of table.seats) {
      expect(fates.get(seat.seat), `human seat ${seat.seat} reveal row`).toBeDefined();
    }
  } finally {
    await table.close();
  }
});
