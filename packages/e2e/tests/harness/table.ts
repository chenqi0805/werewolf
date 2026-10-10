import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Role, Seat } from '@werewolf/engine';

import { ROLE_LABELS, SELECTORS, dayOfTitle } from './labels';
import { closeSpeechSockets } from './speechSocket';
/** One seated player: the page holding the seat and the role it was dealt. */
export interface SeatPage {
  seat: Seat;
  role: Role;
  page: Page;
  context: BrowserContext;
}

export interface Table {
  code: string;
  /** Ordered by seat number (1..12). */
  seats: SeatPage[];
  roleOf(seat: Seat): Role;
  wolves(): SeatPage[];
  close(): Promise<void>;
}

export interface OpenTableOptions {
  /** Board to create with; classic when unset. */
  board?: 'classic' | 'wolfking';
  /** Human contexts to seat; the host fills the rest with AI players. */
  humans?: number;
}

/**
 * Seats 12 players at one table: the first page creates a room (picking the
 * board when asked), the rest join by code, AI players fill any remainder,
 * any seated player starts, and every human page then reads its own seat
 * number and dealt role off the game screen. The random deal is discovered
 * here — the scripted plans close over the result.
 */
export async function openTable(browser: Browser, opts: OpenTableOptions = {}): Promise<Table> {
  const humans = opts.humans ?? 12;
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (let i = 0; i < humans; i += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('/');
      contexts.push(context);
      pages.push(page);
    }

    // The first page creates; the room code is public lobby data.
    const first = pages[0] as Page;
    if (opts.board === 'wolfking') {
      await first.locator(SELECTORS.boardOptionWolfKing).click();
    }
    await first.locator(SELECTORS.createRoomButton).click();
    await expect(first.locator(SELECTORS.roomCode)).toBeVisible();
    const code = ((await first.locator(SELECTORS.roomCode).textContent()) ?? '').trim();
    expect(code, 'room code').not.toBe('');

    for (const page of pages.slice(1)) {
      await page.locator(SELECTORS.roomCodeInput).fill(code);
      await page.locator(SELECTORS.joinRoomButton).click();
    }

    if (humans < 12) {
      const addBot = first.locator(SELECTORS.addBotButton);
      for (let filled = humans; filled < 12; filled += 1) {
        await addBot.click();
        await expect(first.locator(SELECTORS.lobbyCount).last()).toHaveText(
          `${filled + 1}/12 人已入座`,
        );
      }
    }

    // Every page waits for the full table before anyone starts the game.
    await Promise.all(
      pages.map((page) =>
        expect(page.locator(SELECTORS.lobbyCount).last()).toHaveText('12/12 人已入座'),
      ),
    );
    await first.locator(SELECTORS.startButton).click();

    const seats: SeatPage[] = await Promise.all(
      pages.map(async (page, index): Promise<SeatPage> => {
        await expect(page.locator(SELECTORS.seatCaption).first()).toBeVisible();
        const caption = (await page.locator(SELECTORS.seatCaption).first().textContent()) ?? '';
        const seat = Number(caption.match(/你的座位 (\d+) 号/)?.[1]);
        expect(seat, `seat caption “${caption}”`).toBeGreaterThan(0);

        const role = await readRole(page);
        return { seat, role, page, context: contexts[index] as BrowserContext };
      }),
    );
    seats.sort((a, b) => a.seat - b.seat);
    expect(
      seats.map((s) => s.seat),
      'one human per distinct seat',
    ).toEqual([...seats.map((s) => s.seat)].sort((a, b) => a - b));
    expect(new Set(seats.map((s) => s.seat)).size, 'no duplicated seats').toBe(humans);
    for (const seat of seats) {
      expect(seat.seat, `seat ${seat.seat} in range`).toBeGreaterThanOrEqual(1);
      expect(seat.seat, `seat ${seat.seat} in range`).toBeLessThanOrEqual(12);
    }

    const roles = new Map<Seat, Role>(seats.map((s) => [s.seat, s.role]));
    return {
      code,
      seats,
      roleOf: (seat) => {
        const role = roles.get(seat);
        if (role === undefined) throw new Error(`no role for seat ${seat}`);
        return role;
      },
      wolves: () => seats.filter((s) => s.role === 'werewolf').sort((a, b) => a.seat - b.seat),
      close: async () => {
        closeSpeechSockets();
        await Promise.all(contexts.map((context) => context.close()));
      },
    };
  } catch (error) {
    await Promise.all(contexts.map((context) => context.close()));
    throw error;
  }
}

/** The viewer's own role, off the badge row (警长/出局 badges are distinct). */
async function readRole(page: Page): Promise<Role> {
  await expect(page.locator(SELECTORS.roleBadge).first()).toBeVisible();
  const badges = await page.locator(SELECTORS.roleBadge).allTextContents();
  for (const badge of badges) {
    const role = ROLE_LABELS[badge.trim()];
    if (role !== undefined) return role;
  }
  throw new Error(`no role badge among “${badges.join('、')}”`);
}

/** Current day number from the game screen title; null off the game screen. */
export async function dayNumberOf(page: Page): Promise<number | null> {
  const title = await page.locator('.scr-title').first().textContent({ timeout: 2_000 });
  return dayOfTitle(title);
}

/**
 * The first seat's page — the anchor view reveal/log assertions read. The
 * table always seats twelve, so a missing seat means the harness broke.
 */
export function anchorPage(table: Table): Page {
  const seat = table.seats[0];
  if (!seat) throw new Error('the table has no seats');
  return seat.page;
}
