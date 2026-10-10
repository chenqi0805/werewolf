import { expect, test } from '@playwright/test';

import { playScriptedGame } from './harness/driver';
import { wolfWinPlan } from './harness/plans';
import { SELECTORS } from './harness/labels';
import { dayLogText, expectPostgameSection, revealFates } from './harness/reveal';
import { openTable, anchorPage } from './harness/table';

/** Evidence directory for game-over screenshots (CI artifact / QA upload). */
const EVIDENCE_DIR = process.env.WEREWOLF_EVIDENCE_DIR;

test('scenario A: 12 seats play a full game to a wolf win — 屠边 via the villagers', async ({
  browser,
}) => {
  const table = await openTable(browser);
  try {
    const roles = new Map(table.seats.map((seat) => [seat.seat, seat.role]));
    const winner = await playScriptedGame(table, wolfWinPlan(roles), {
      label: 'wolf-win',
      evidenceDir: EVIDENCE_DIR,
    });
    expect(winner).toBe('wolves');

    // 屠边 via the villagers: all four villagers are out, every other seat
    // survived — no god died, no exile ever landed, the hunter never shot.
    const fates = await revealFates(anchorPage(table));
    for (const [seat, role] of roles) {
      expect(fates.get(seat), `seat ${seat} (${role}) reveal row`).toBeDefined();
      if (role === 'villager') expect(fates.get(seat), `seat ${seat}`).toBe('出局');
      else expect(fates.get(seat), `seat ${seat}`).toBe('存活');
    }

    const log = await dayLogText(anchorPage(table));
    const announced = log.match(/昨晚出局/g)?.length ?? 0;
    expect(announced, 'night deaths announced in the public log').toBeGreaterThanOrEqual(3);
    expect(log).not.toContain('被放逐出局');
    expect(log).not.toContain('猎人开枪');

    // The 复盘 section rode the same reveal: the shared stats grid renders,
    // and with no assistant provider the 生成复盘 click lands on 未配置.
    await expectPostgameSection(anchorPage(table));

    // Spectator exit: a 13th connection joins by code. The server's only
    // spectator admission is a finished room (a running game acks
    // GAME_RUNNING), so the seat-less viewer lands on the reveal with the
    // 返回主页 control — clicking it returns to the main page without
    // touching any seat or emitting room:leave (the mid-game spectator
    // branch is covered by the GameScreen component test).
    const spectatorContext = await browser.newContext();
    const spectator = await spectatorContext.newPage();
    try {
      await spectator.goto('/');
      await spectator.locator(SELECTORS.roomCodeInput).fill(table.code);
      await spectator.locator(SELECTORS.joinRoomButton).click();
      await expect(spectator.locator(SELECTORS.gameOver)).toBeVisible();
      await expect(spectator.locator(SELECTORS.exitButton)).toBeVisible();
      await spectator.locator(SELECTORS.exitButton).click();
      await expect(spectator.locator(SELECTORS.createRoomButton)).toBeVisible();
      await expect(spectator.locator(SELECTORS.gameOver)).toHaveCount(0);
    } finally {
      await spectatorContext.close();
    }
  } finally {
    await table.close();
  }
});
