import { expect, test, type Page } from '@playwright/test';
import type { GameEvent, Seat } from '@werewolf/engine';
import type { PlayerView, VoiceChunk } from '@werewolf/server';

import { openSeatSocket, type SeatSpeechSocket } from './harness/speechSocket';
import { openTable } from './harness/table';

/**
 * The transcript the fake recognizer hands the composer — unique phrasing so
 * the SPEECH_MADE match on the wire can only be this slot's submission.
 */
const TRANSCRIPT = '大家好，我先听一听，稍后再看预言家的查验';

/** One seat's rider socket plus everything it has collected since attach. */
interface Rider {
  seat: Seat;
  socket: SeatSpeechSocket;
  view: PlayerView | null;
  chunks: VoiceChunk[];
  speeches: Extract<GameEvent, { type: 'SPEECH_MADE' }>[];
}

test.use({
  // Fake media: the mic prompt auto-grants and getUserMedia returns a live
  // (synthetic) audio track — real capture, real MediaRecorder frames at the
  // real 250ms cadence, no hardware. The transcript itself comes from the
  // stubbed Web Speech engine installed per page below: Chrome's actual
  // speech service is a cloud dependency a CI runner cannot bank on.
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

test('scenario E: fake-media voice — the table hears the speaker live and the transcript lands', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const table = await openTable(browser);
  try {
    // The recognizer is constructed lazily when a speech slot begins, so the
    // stub can be installed any time before the first slot opens.
    await Promise.all(table.seats.map((seat) => installSpeechStub(seat.page)));

    // Two seats also ride Node-side sockets (their own session tokens, the
    // room's socket set — the relay treats each as one more table member).
    // Whichever is not speaking is the listener; both collect regardless.
    const riders: Rider[] = [];
    for (const seatPage of table.seats.slice(0, 2)) {
      const socket = await openSeatSocket(seatPage.seat, seatPage.page);
      const rider: Rider = { seat: seatPage.seat, socket, view: null, chunks: [], speeches: [] };
      socket.on('game:view', (view) => {
        rider.view = view;
      });
      socket.on('voice:chunk', (chunk) => {
        rider.chunks.push(chunk);
      });
      socket.on('game:event', (event) => {
        if (event.type === 'SPEECH_MADE') rider.speeches.push(event);
      });
      riders.push(rider);
    }

    // The game plays itself to the first day-speech slot: nobody acts, so the
    // night defaults to 空刀 (平安夜) and the void election flows into the
    // day's speeches. The current speaker is read off the riders' own views —
    // the same filtered projection the players see.
    const speakerSeat = await firstSpeechSeat(riders);
    const listener = riders.find((rider) => rider.seat !== speakerSeat);
    if (!listener) throw new Error('no rider seat left to listen from');

    // The speaker's composer auto-captures (fake mic) and auto-submits the
    // stubbed transcript ~1s before the slot deadline — the real client path.
    // The listener must have heard the relayed frames, in recording order.
    await expect.poll(() => listener.chunks.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    const seqs = listener.chunks.map((chunk) => chunk.seq);
    expect(seqs[0], 'relay order starts at the first frame').toBe(1);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i], `frame ${i} follows its predecessor`).toBe((seqs[i - 1] ?? 0) + 1);
    }
    for (const chunk of listener.chunks) {
      expect(chunk.seat, 'every relayed frame is the speaker’s').toBe(speakerSeat);
      expect(chunk.data.byteLength, 'frames carry audio bytes').toBeGreaterThan(0);
    }

    // The transcript of record: the slot's public SPEECH_MADE, carrying the
    // stub text under the speaker's seat.
    await expect
      .poll(
        () =>
          listener.speeches.some(
            (event) => event.seat === speakerSeat && event.text === TRANSCRIPT,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    // And the public record reached another player's screen — the listener
    // page renders the speaker's line in its speech history.
    const listenerPage = table.seats.find((seat) => seat.seat === listener.seat);
    if (!listenerPage) throw new Error(`no page for listener seat ${listener.seat}`);
    // The transcript renders in both speech surfaces: the live transcript
    // panel and the per-day speech history.
    const live = listenerPage.page.getByRole('region', { name: '发言', exact: true });
    await expect(live.getByText(TRANSCRIPT)).toBeVisible();
    const history = listenerPage.page.getByRole('region', { name: '发言记录' });
    await expect(history.getByText(TRANSCRIPT)).toBeVisible();
  } finally {
    await table.close();
  }
});

/** Installs a Web Speech stub whose start() immediately finalizes the transcript. */
async function installSpeechStub(page: Page): Promise<void> {
  await page.evaluate((text: string) => {
    class FakeRecognition {
      lang = 'zh-CN';
      continuous = false;
      interimResults = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start(): void {
        const event = { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] };
        setTimeout(() => this.onresult?.(event), 50);
      }
      stop(): void {}
    }
    (globalThis as Record<string, unknown>).SpeechRecognition = FakeRecognition;
  }, TRANSCRIPT);
}

/** Polls the riders' views until the first day-speech slot opens; its speaker. */
async function firstSpeechSeat(riders: Rider[]): Promise<Seat> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    for (const rider of riders) {
      const step = rider.view?.step;
      if (step?.kind === 'speech' && step.order !== null) {
        const seat = step.order[step.cursor];
        if (seat !== undefined) return seat;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('no day-speech slot opened within 90s');
}
