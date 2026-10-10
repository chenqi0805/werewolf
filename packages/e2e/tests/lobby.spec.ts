import { expect, test } from '@playwright/test';

import { SELECTORS } from './harness/labels';

/**
 * The reported lobby bugs: the header claimed 12/12 人已入座 with one seat
 * taken, and there was no way to leave a room. One table, two browsers, no
 * game started.
 */
test('lobby shows true occupancy and quit frees the seat', async ({ browser }) => {
  const creatorContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  await creator.goto('/');
  await creator.locator(SELECTORS.createRoomButton).click();
  await expect(creator.locator(SELECTORS.roomCode)).toBeVisible();
  const code = ((await creator.locator(SELECTORS.roomCode).textContent()) ?? '').trim();
  expect(code).not.toBe('');

  // The reported bug: one seated player claimed 12/12.
  await expect(creator.locator(SELECTORS.lobbyCount).last()).toHaveText('1/12 人已入座');
  // Below the exactly-12 rule the start control says so instead of erroring later.
  await expect(creator.getByRole('button', { name: '人满后开局' })).toBeDisabled();

  const joinerContext = await browser.newContext();
  const joiner = await joinerContext.newPage();
  await joiner.goto('/');
  await joiner.locator(SELECTORS.roomCodeInput).fill(code);
  await joiner.locator(SELECTORS.joinRoomButton).click();

  // Join/leave broadcast: the creator's count follows the join.
  await expect(creator.locator(SELECTORS.lobbyCount).last()).toHaveText('2/12 人已入座');

  await joiner.locator(SELECTORS.quitButton).click();
  await expect(joiner.locator(SELECTORS.createRoomButton)).toBeVisible();
  await expect(creator.locator(SELECTORS.lobbyCount).last()).toHaveText('1/12 人已入座');
  // The freed seat renders as an empty chair again.
  await expect(creator.locator('[aria-label*="空位"]').first()).toBeVisible();

  await creatorContext.close();
  await joinerContext.close();
});

// Provider-free assertion: the e2e boot pins the invite env unconfigured
// (scripts/start-server.mjs), so the view carries no inviteAvailable hint and
// the 邮件邀请 affordance must not render at all.
test('no email sender configured: the lobby hides the invite affordance', async ({ browser }) => {
  // Only the suite's own boot guarantees an unconfigured sender; a hosted
  // deployment (WEREWOLF_BASE_URL) may legitimately show the affordance.
  test.skip(Boolean(process.env.WEREWOLF_BASE_URL), 'a hosted deployment may have a sender');
  const context = await browser.newContext();
  const creator = await context.newPage();
  await creator.goto('/');
  await creator.locator(SELECTORS.createRoomButton).click();
  await expect(creator.locator(SELECTORS.roomCode)).toBeVisible();
  await expect(creator.locator(SELECTORS.inviteGroup)).toHaveCount(0);
  await context.close();
});

// The link landing is pure client behavior — no room needed: the connect
// form's code field pre-fills from ?room=CODE on mount.
test('an invite link landing pre-fills the room code', async ({ page }) => {
  await page.goto('/?room=AB2C');
  await expect(page.locator(SELECTORS.roomCodeInput)).toHaveValue('AB2C');
});
