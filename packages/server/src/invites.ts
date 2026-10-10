import type { BoardId, Seat } from '@werewolf/engine';
import { BOARDS, SEAT_COUNT } from '@werewolf/engine';
import type { RoomRegistry } from './room';

/**
 * Email invites — a seated player sends a friend a one-shot join link.
 *
 * The strategy-assistant module is the implementation template, end to end:
 * the provider resolves at boot, sends ride a per-room:seat budget under a
 * per-room lifetime cap, the handler is always attached (no provider → every
 * request still acks INVITE_UNAVAILABLE), and the outbound HTTP call hangs on
 * a test seam.
 * Sends are stateless one-shots — nothing about a recipient is stored, and
 * nothing here touches the engine: an invite is room metadata in motion.
 *
 * The email carries public information only: the room code, the join link,
 * and the board's name. No seat data, no roles — cards are dealt at start.
 */
export type MailSender = (mail: { to: string; subject: string; html: string }) => Promise<void>;

export interface InviteOptions {
  /**
   * WEREWOLF_PUBLIC_BASE_URL — the deployment's public origin. Boot-validated
   * (validatePublicBaseUrl): invite links are built from this operator input,
   * never from per-request Host headers, which a client can spoof.
   */
  baseUrl: string;
  /** WEREWOLF_INVITE_FROM ?? DEFAULT_INVITE_FROM (Resend's onboarding sender). */
  from: string;
  /** RESEND_API_KEY — arms the Resend HTTP sender. Unset = INVITE_UNAVAILABLE. */
  apiKey?: string;
  /** Test seam: replace the Resend HTTP call. Never set in production. */
  sendImpl?: MailSender;
  /** Test seam under resendMailSender's fetch. Never set in production. */
  fetchImpl?: typeof fetch;
  /** Test knob: invites per room:seat per lobby (default MAX_INVITES_PER_LOBBY). */
  maxInvitesPerLobby?: number;
  /** Test knob: lifetime invites per room across all seats (default MAX_INVITES_PER_ROOM). */
  maxInvitesPerRoom?: number;
}

/**
 * Resend's onboarding sender — deliverable before a domain is verified, and
 * the documented fallback when WEREWOLF_INVITE_FROM is unset.
 */
export const DEFAULT_INVITE_FROM = 'onboarding@resend.dev';

/** The Resend HTTPS send endpoint — plain egress the deployment already exercises. */
export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** RFC 5321's forward-path ceiling — the "length" half of address validation. */
export const MAX_EMAIL_LENGTH = 254;

/** Invites one seat may send into one lobby — bounded provider billing. */
export const MAX_INVITES_PER_LOBBY = 10;

/**
 * Lifetime invites one room may spend across every seat — a minted room's
 * total email volume is bounded, so a room-creation flood cannot compound
 * into an email flood (audit F4).
 */
export const MAX_INVITES_PER_ROOM = 20;

/** Ack error codes for room:invite — stable protocol values. */
export const INVITE_ERROR_CODES = [
  'NOT_IN_ROOM',
  'INVALID_EMAIL',
  'INVITE_UNAVAILABLE',
  'INVITE_BUSY',
  'INVITE_RATE_LIMITED',
  'INVITE_ERROR',
] as const;

export class InviteProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteProviderError';
  }
}

/**
 * Boot validation for WEREWOLF_PUBLIC_BASE_URL. Operator mistakes fail
 * loudly here rather than poisoning every invite link: the value must be an
 * absolute http(s) URL with no query or fragment (links append `?room=CODE`),
 * returned with trailing slashes stripped.
 */
export function validatePublicBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new Error(`WEREWOLF_PUBLIC_BASE_URL is not an absolute URL: ${trimmed}`, {
      cause: error,
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`WEREWOLF_PUBLIC_BASE_URL must be an http(s) URL, got "${url.protocol}".`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(
      'WEREWOLF_PUBLIC_BASE_URL must not carry a query string or fragment — invite links append ?room=CODE.',
    );
  }
  return trimmed.replace(/\/+$/, '');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The address gate, applied before budget or provider is touched: one @, a
 * dotted domain, no whitespace, and within the RFC length ceiling. Pragmatic
 * on purpose — the table's failure mode is a typo, not a clever forgery.
 */
export function isValidInviteEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

/**
 * The provider seam's production implementation: Resend's plain-HTTPS API.
 * The from-address is bound here so every send rides one verified identity.
 */
export function resendMailSender(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): MailSender {
  return async (mail) => {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
      }),
    });
    if (!response.ok) throw new InviteProviderError(`HTTP ${response.status}`);
  };
}

/**
 * The email's cargo: the room code, the join link, and a one-line board
 * blurb — public information, so the assembly needs no GameState. Every
 * interpolated value is server-generated (the code alphabet, a boot-validated
 * base URL, a registry board name), so no HTML escaping is required.
 */
export function buildInviteEmail(
  code: string,
  boardId: BoardId,
  baseUrl: string,
): { subject: string; html: string } {
  const link = `${baseUrl}/?room=${code}`;
  const board = BOARDS[boardId];
  return {
    subject: `狼人杀局:来房间 ${code}`,
    html: [
      '<p>朋友请你来一局线上狼人杀。</p>',
      `<p>板子:${board.name} · ${SEAT_COUNT} 人局</p>`,
      `<p>房间号:<strong>${code}</strong></p>`,
      `<p><a href="${link}">点击加入房间 ${code}</a></p>`,
      `<p>链接打不开时,访问 ${baseUrl} 并输入房间号也可以。</p>`,
    ].join(''),
  };
}

/** Ack-shaped event — the ok (or a stable error code) comes back per socket. */
export interface InviteAck {
  (resp: { ok: true } | { error: string }): void;
}

/** Structural view of a bound socket — the gateway's sockets fit as-is. */
export interface InviteSocket {
  readonly data: { roomCode: string | null; seat: Seat | null };
  on(event: 'room:invite', handler: (email: string, ack: InviteAck) => void): void;
}

export interface InviteServer {
  on(event: 'connection', handler: (socket: InviteSocket) => void): void;
}

/**
 * Boot-time provider resolution: an explicit test seam wins, a configured
 * key builds the Resend sender, and nothing configured leaves no sender —
 * the handler still attaches and acks INVITE_UNAVAILABLE.
 */
export function resolveInviteSender(opts: InviteOptions | undefined): MailSender | null {
  if (opts?.sendImpl) return opts.sendImpl;
  if (opts?.apiKey !== undefined && opts.apiKey !== '') {
    return resendMailSender(opts.apiKey, opts.from, opts.fetchImpl);
  }
  return null;
}

interface LobbyBudget {
  count: number;
  inflight: boolean;
}

/**
 * Registers the room:invite handler. Always attached: with no sender
 * configured every request still acks — INVITE_UNAVAILABLE — so clients
 * never hang on a missing feature. Returns whether a sender resolved, the
 * capability hint the lobby view carries (no extra round trip).
 */
export function attachInvites(
  io: InviteServer,
  registry: Pick<RoomRegistry, 'get'>,
  opts?: InviteOptions,
): boolean {
  const sender = resolveInviteSender(opts);
  const baseUrl = opts?.baseUrl ?? '';
  const maxInvites = opts?.maxInvitesPerLobby ?? MAX_INVITES_PER_LOBBY;
  const maxRoomInvites = opts?.maxInvitesPerRoom ?? MAX_INVITES_PER_ROOM;
  const budgets = new Map<string, LobbyBudget>();
  // One lifetime number per room. Entries share the per-seat budgets'
  // memory model — no eviction seam exists on the registry view here.
  const roomCounts = new Map<string, number>();

  io.on('connection', (socket) => {
    socket.on('room:invite', (email, ack) => {
      if (typeof ack !== 'function') return;
      // The seated check is free from socket.data — spectators and
      // unbound sockets have nobody to vouch for.
      const { roomCode, seat } = socket.data;
      const room = roomCode !== null ? registry.get(roomCode) : undefined;
      if (!room || seat === null) {
        ack({ error: 'NOT_IN_ROOM' });
        return;
      }
      // Address validation precedes budget and provider: a malformed input
      // is rejected even in degraded mode, before anything is spent.
      const address = typeof email === 'string' ? email.trim() : '';
      if (!isValidInviteEmail(address)) {
        ack({ error: 'INVALID_EMAIL' });
        return;
      }
      if (!sender) {
        ack({ error: 'INVITE_UNAVAILABLE' });
        return;
      }
      // The room's lifetime pool is checked before any seat's slice: once
      // it is spent no seat can send, and waiting out an in-flight send will
      // not help — RATE_LIMITED is the truthful ack even mid-send.
      const roomSpent = roomCounts.get(room.code) ?? 0;
      if (roomSpent >= maxRoomInvites) {
        ack({ error: 'INVITE_RATE_LIMITED' });
        return;
      }
      const budgetKey = `${room.code}:${seat}`;
      let budget = budgets.get(budgetKey);
      if (budget === undefined) {
        budget = { count: 0, inflight: false };
        budgets.set(budgetKey, budget);
      }
      if (budget.inflight) {
        ack({ error: 'INVITE_BUSY' });
        return;
      }
      if (budget.count >= maxInvites) {
        ack({ error: 'INVITE_RATE_LIMITED' });
        return;
      }
      budget.count += 1;
      // The room spend commits with the seat's — an attempt, counted before
      // the send like the per-seat budget, and kept on provider failure.
      roomCounts.set(room.code, roomSpent + 1);
      budget.inflight = true;
      const mail = { to: address, ...buildInviteEmail(room.code, room.boardId, baseUrl) };
      void (async () => {
        try {
          await sender(mail);
          ack({ ok: true });
        } catch (error) {
          // Provider failures log and degrade — they never throw into the
          // room loop, and the seat's budget stays honest via finally.
          console.error('[werewolf] room:invite send failed:', error);
          ack({ error: 'INVITE_ERROR' });
        } finally {
          budget.inflight = false;
        }
      })();
    });
  });

  return sender !== null;
}
