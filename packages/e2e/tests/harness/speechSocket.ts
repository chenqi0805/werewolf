import type { Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import type { Seat } from '@werewolf/engine';
import type {
  ClientToServerEvents,
  PlayerView,
  RejoinAck,
  ServerToClientEvents,
} from '@werewolf/server';

type SpeechSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type { SpeechSocket as SeatSpeechSocket };

interface StoredSession {
  roomCode: string;
  seat: number;
  sessionToken: string;
}

/**
 * Speech slots are voice-only in the client — the scripted scenarios cannot
 * type into a composer. Each seat gets a dedicated Node-side socket that
 * reattaches its session token; the gateway keeps a socket-set per room,
 * so the seat's page keeps receiving views while this socket acts for it.
 * "My slot" is read from that socket's own `game:view` stream — the same
 * filtered projection a player sees.
 */

const sockets = new Map<Seat, SpeechSocket>();
const views = new Map<Seat, PlayerView>();

/** Connects (once) a speaker socket for the seat and reattaches its session. */
async function ensureSeatSocket(seat: Seat, page: Page): Promise<SpeechSocket> {
  const existing = sockets.get(seat);
  if (existing) return existing;

  // The e2e tsconfig has no DOM lib — reach localStorage through a minimal
  // structural cast on globalThis instead of the untyped `window` global.
  type PageStorage = { localStorage: { getItem(key: string): string | null } };
  const stored = await page.evaluate(() =>
    (globalThis as unknown as PageStorage).localStorage.getItem('werewolf-session'),
  );
  if (stored === null) throw new Error(`seat ${seat} has no stored session to reattach`);
  const session = JSON.parse(stored) as StoredSession;

  const origin = new URL(page.url()).origin;
  if (origin === 'null' || origin === '') throw new Error(`seat ${seat} page has no origin yet`);

  const socket: SpeechSocket = io(origin, {
    transports: ['websocket', 'polling'],
    timeout: 10_000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', (error: Error) =>
      reject(new Error(`seat ${seat} connect: ${error.message}`)),
    );
  });
  socket.on('game:view', (view) => {
    if (view.you.seat !== null) views.set(seat, view);
  });

  const resp = await new Promise<RejoinAck | { error: string }>((resolve) => {
    socket.emit('room:rejoin', session.roomCode, session.sessionToken, resolve);
  });
  if ('error' in resp) throw new Error(`seat ${seat} reattach failed: ${resp.error}`);
  sockets.set(seat, socket);
  return socket;
}

/** Mirrors the client's `canSpeakNow` on the seat's own filtered view. */
function isMySpeechSlot(view: PlayerView, seat: Seat): boolean {
  if (!view.you.alive) return false;
  const step = view.step;
  const speaker =
    (step.kind === 'speech' && step.order ? (step.order[step.cursor] ?? null) : null) ??
    (step.kind === 'last-words' ? (step.queue[step.cursor] ?? null) : null) ??
    (step.kind === 'sheriff-speech' ? (step.queue[step.cursor] ?? null) : null) ??
    (step.kind === 'pk-speech' ? (step.tied[step.cursor] ?? null) : null);
  return speaker === seat;
}

/**
 * Posts the seat's speech line through its socket — true when the line went
 * out (the slot was the seat's), false when the seat must keep waiting.
 */
export async function speakViaSocket(seat: Seat, page: Page, text: string): Promise<boolean> {
  const socket = await ensureSeatSocket(seat, page);
  const view = views.get(seat);
  if (view === undefined || !isMySpeechSlot(view, seat)) return false;
  socket.emit('game:action', { type: 'SPEAK', actor: seat, text });
  return true;
}

/**
 * Opens (or returns) the seat's rider socket for callers that attach their own
 * handlers — the voice scenario listens for relayed `voice:chunk`s and public
 * `game:event`s on it. The socket joins the room's socket set, so the relay
 * treats it as one more table member.
 */
export async function openSeatSocket(seat: Seat, page: Page): Promise<SpeechSocket> {
  return ensureSeatSocket(seat, page);
}

/** Closes every speaker socket — called with the table teardown. */
export function closeSpeechSockets(): void {
  for (const socket of sockets.values()) socket.disconnect();
  sockets.clear();
  views.clear();
}
