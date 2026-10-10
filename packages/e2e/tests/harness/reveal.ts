import { expect, type Page } from '@playwright/test';

import { SELECTORS } from './labels';

export type Fate = '存活' | '出局';

/**
 * The game-over reveal as a seat → fate map, parsed from the per-seat rows
 * (`N号` + role label + 存活/出局) rendered by GameOverReveal.
 */
export async function revealFates(page: Page): Promise<Map<number, Fate>> {
  const rows = page.locator(`${SELECTORS.gameOver} li`);
  const fates = new Map<number, Fate>();
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const text = (await rows.nth(index).textContent()) ?? '';
    const match = text.match(
      /^(\d+)号(?:狼人|白狼王|村民|预言家|女巫|猎人|守卫|白痴)(存活|出局)$/u,
    );
    if (match) fates.set(Number(match[1]), match[2] as Fate);
  }
  return fates;
}

/** The public day log's full text, as rendered on the game-over screen. */
export async function dayLogText(page: Page): Promise<string> {
  return (await page.locator('[aria-label="对局记录"]').textContent()) ?? '';
}

/** The 每轮票形 panel's full text — every resolved round's ballot reveal. */
export async function voteHistoryText(page: Page): Promise<string> {
  return (await page.locator(SELECTORS.voteHistory).textContent()) ?? '';
}

/**
 * The 复盘 section on the game-over screen: the deterministic stats grid is
 * always rendered — one row per seat, the whole table's shared numbers —
 * and the 生成复盘 click settles the AI block. Where no assistant provider is
 * configured (local/CI e2e) that is the 未配置 state; on a hosted run the
 * click arms the real generation and the section fills with the review, so
 * the wait is generous there. Both are legitimate settled states; an error
 * or a timeout is a real failure.
 */
export async function expectPostgameSection(page: Page): Promise<void> {
  await expect(page.locator(SELECTORS.postgameSection)).toBeVisible();
  const grid = page.locator(SELECTORS.postgameGrid);
  await expect(grid).toBeVisible();
  await expect(grid.locator('tbody tr')).toHaveCount(12);
  await page.locator(SELECTORS.postgameAskButton).click();
  const settled = page
    .locator(SELECTORS.postgameReview)
    .or(page.locator(SELECTORS.postgameUnconfigured));
  await expect(settled.first()).toBeVisible({
    timeout: process.env.WEREWOLF_BASE_URL ? 300_000 : 15_000,
  });
}
