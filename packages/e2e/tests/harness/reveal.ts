import type { Page } from '@playwright/test';

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
    const match = text.match(/^(\d+)号(?:狼人|村民|预言家|女巫|猎人|白痴)(存活|出局)$/u);
    if (match) fates.set(Number(match[1]), match[2] as Fate);
  }
  return fates;
}

/** The public day log's full text, as rendered on the game-over screen. */
export async function dayLogText(page: Page): Promise<string> {
  return (await page.locator('[aria-label="对局记录"]').textContent()) ?? '';
}
