import { describe, expect, it, vi } from 'vitest';
import type { Seat } from '@werewolf/engine';
import {
  attachInvites,
  buildInviteEmail,
  isValidInviteEmail,
  resendMailSender,
  resolveInviteSender,
  validatePublicBaseUrl,
  MAX_EMAIL_LENGTH,
  RESEND_ENDPOINT,
  type InviteAck,
  type InviteOptions,
  type InviteServer,
  type InviteSocket,
  type MailSender,
} from '../invites';
import type { Room, RoomRegistry } from '../room';
import { fixedRoom } from './fixtures';

type FetchInput = Parameters<typeof fetch>[0];

class FakeInviteServer implements InviteServer {
  private connectionHandler: ((socket: InviteSocket) => void) | null = null;
  on(_event: 'connection', handler: (socket: InviteSocket) => void): void {
    this.connectionHandler = handler;
  }
  connect(socket: InviteSocket): void {
    this.connectionHandler?.(socket);
  }
}

class FakeInviteSocket implements InviteSocket {
  data: { roomCode: string | null; seat: Seat | null } = { roomCode: null, seat: null };
  private ackHandler: ((email: string, ack: InviteAck) => void) | null = null;
  on(_event: 'room:invite', handler: (email: string, ack: InviteAck) => void): void {
    this.ackHandler = handler;
  }
  /** Sends one invite and resolves with whatever the handler acked. */
  invite(email: unknown): Promise<{ ok: true } | { error: string }> {
    return new Promise((resolve) => {
      this.ackHandler?.(email as string, (resp) => resolve(resp));
    });
  }
}

/** Seat a fake socket into a room (the gateway's socket.data binding). */
function bind(socket: FakeInviteSocket, code: string | null, seat: Seat | null): void {
  socket.data = { roomCode: code, seat };
}

function registryOf(room: Room): Pick<RoomRegistry, 'get'> {
  return { get: (code: string) => (code === room.code ? room : undefined) };
}

/** The configured opts every send test rides: fake sender, fixed base URL. */
function inviteOpts(sendImpl: MailSender, extra: Partial<InviteOptions> = {}): InviteOptions {
  return {
    baseUrl: 'https://werewolf.example',
    from: 'invites@werewolf.example',
    sendImpl,
    ...extra,
  };
}

/** A lobby room with two seated humans — the sender and an invited friend. */
function lobbyWithTwo(): Room {
  const room = fixedRoom();
  room.join(); // seat 1
  room.join(); // seat 2
  return room;
}

describe('resolveInviteSender', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveInviteSender(undefined)).toBeNull();
    expect(resolveInviteSender({ baseUrl: 'https://werewolf.example', from: 'a@b.c' })).toBeNull();
    expect(
      resolveInviteSender({ baseUrl: 'https://werewolf.example', from: 'a@b.c', apiKey: '' }),
    ).toBeNull();
  });

  it('prefers the explicit sendImpl seam (test override)', () => {
    const sendImpl: MailSender = vi.fn();
    const sender = resolveInviteSender({
      baseUrl: 'https://werewolf.example',
      from: 'a@b.c',
      apiKey: 'sk',
      sendImpl,
    });
    expect(sender).toBe(sendImpl);
  });

  it('builds a Resend sender from a configured key', () => {
    const sender = resolveInviteSender({
      baseUrl: 'https://werewolf.example',
      from: 'a@b.c',
      apiKey: 're_sk',
    });
    expect(sender).toBeTypeOf('function');
  });
});

describe('validatePublicBaseUrl', () => {
  it('accepts absolute http(s) origins and strips trailing slashes', () => {
    expect(validatePublicBaseUrl('https://werewolf.example')).toBe('https://werewolf.example');
    expect(validatePublicBaseUrl('https://werewolf.example/')).toBe('https://werewolf.example');
    expect(validatePublicBaseUrl('http://127.0.0.1:3210/werewolf/')).toBe(
      'http://127.0.0.1:3210/werewolf',
    );
  });

  it('fails loudly at boot on operator mistakes', () => {
    expect(() => validatePublicBaseUrl('werewolf.example')).toThrow(); // no protocol
    expect(() => validatePublicBaseUrl('ftp://werewolf.example')).toThrow();
    expect(() => validatePublicBaseUrl('https://werewolf.example/?utm=x')).toThrow(); // query
    expect(() => validatePublicBaseUrl('https://werewolf.example/#room')).toThrow(); // fragment
  });
});

describe('isValidInviteEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidInviteEmail('friend@example.com')).toBe(true);
    expect(isValidInviteEmail('a.b+c@mail.example.co.jp')).toBe(true);
  });

  it('rejects the plausible mistakes', () => {
    expect(isValidInviteEmail('')).toBe(false);
    expect(isValidInviteEmail('   ')).toBe(false);
    expect(isValidInviteEmail('friend@example')).toBe(false); // no dot
    expect(isValidInviteEmail('@example.com')).toBe(false); // no local part
    expect(isValidInviteEmail('friend example.com')).toBe(false); // no @
    expect(isValidInviteEmail('friend@exa mple.com')).toBe(false); // inner space
    expect(isValidInviteEmail(`${'a'.repeat(250)}@example.com`)).toBe(false); // over 254
    expect(isValidInviteEmail(`${'a'.repeat(240)}@example.com`)).toBe(true); // 252 — inside
  });

  it('caps length at the RFC 5321 forward-path ceiling', () => {
    expect(MAX_EMAIL_LENGTH).toBe(254);
  });
});

describe('buildInviteEmail', () => {
  it('carries the room code, the full join link, and the board blurb', () => {
    const mail = buildInviteEmail('AB2C', 'classic', 'https://werewolf.example');
    expect(mail.subject).toContain('AB2C');
    expect(mail.html).toContain('https://werewolf.example/?room=AB2C');
    expect(mail.html).toContain('AB2C');
    expect(mail.html).toContain('标准局'); // the board's registry name, nothing secret
    expect(mail.html).not.toContain('村民'); // no deck dump — a role label the board name never carries
  });

  it('names a non-classic board from the registry', () => {
    const mail = buildInviteEmail('XY7Z', 'wolfking', 'https://werewolf.example');
    expect(mail.html).toContain('白狼王局');
  });
});

describe('resendMailSender', () => {
  it('speaks the Resend wire protocol', async () => {
    const calls: Array<{ url: FetchInput; init?: RequestInit }> = [];
    const sender = resendMailSender('re_sk', 'invites@werewolf.example', async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    await sender({ to: 'friend@example.com', subject: '来了?', html: '<p>来吗</p>' });
    expect(calls[0]?.url).toBe(RESEND_ENDPOINT);
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer re_sk');
    const body = JSON.parse((calls[0]?.init?.body as string) ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      from: 'invites@werewolf.example',
      to: ['friend@example.com'],
      subject: '来了?',
      html: '<p>来吗</p>',
    });
  });

  it('raises InviteProviderError on a non-ok response', async () => {
    const sender = resendMailSender(
      're_sk',
      'invites@werewolf.example',
      async () => new Response('{"message":"bad key"}', { status: 401 }),
    );
    await expect(sender({ to: 'friend@example.com', subject: 's', html: 'h' })).rejects.toThrow(
      'HTTP 401',
    );
  });
});

describe('attachInvites', () => {
  it('acks INVITE_UNAVAILABLE when no sender is configured, without sending', async () => {
    const room = lobbyWithTwo();
    const server = new FakeInviteServer();
    expect(attachInvites(server, registryOf(room)).available).toBe(false); // the lobby hides the affordance
    const socket = new FakeInviteSocket();
    bind(socket, room.code, 1);
    server.connect(socket);
    expect(await socket.invite('friend@example.com')).toEqual({ error: 'INVITE_UNAVAILABLE' });
  });

  it('acks NOT_IN_ROOM for unbound, spectator, or unknown-room sockets', async () => {
    const room = lobbyWithTwo();
    const sent: Array<{ to: string }> = [];
    const server = new FakeInviteServer();
    attachInvites(
      server,
      registryOf(room),
      inviteOpts(async (mail) => void sent.push(mail)),
    );
    for (const [code, seat] of [
      [null, 1 as Seat | null],
      ['MISSING', 1 as Seat | null],
      [room.code, null],
    ] as const) {
      const socket = new FakeInviteSocket();
      bind(socket, code, seat);
      server.connect(socket);
      expect(await socket.invite('friend@example.com')).toEqual({ error: 'NOT_IN_ROOM' });
    }
    expect(sent).toEqual([]);
  });

  it('acks INVALID_EMAIL before budget or provider is touched', async () => {
    const room = lobbyWithTwo();
    const sendImpl: MailSender = vi.fn(async () => {});
    const server = new FakeInviteServer();
    attachInvites(server, registryOf(room), inviteOpts(sendImpl));
    const socket = new FakeInviteSocket();
    bind(socket, room.code, 1);
    server.connect(socket);
    for (const bad of ['not-an-email', 'friend@example', '  ', 42, null]) {
      expect(await socket.invite(bad)).toEqual({ error: 'INVALID_EMAIL' });
    }
    expect(sendImpl).not.toHaveBeenCalled();
    // The order holds in degraded mode too: malformed input says INVALID_EMAIL,
    // never UNAVAILABLE, even with nothing configured.
    const bare = new FakeInviteServer();
    attachInvites(bare, registryOf(room));
    const degraded = new FakeInviteSocket();
    bind(degraded, room.code, 1);
    bare.connect(degraded);
    expect(await degraded.invite('not-an-email')).toEqual({ error: 'INVALID_EMAIL' });
  });

  it('trims the address and sends the code plus full join link', async () => {
    const room = lobbyWithTwo();
    const sent: Array<{ to: string; subject: string; html: string }> = [];
    const server = new FakeInviteServer();
    attachInvites(
      server,
      registryOf(room),
      inviteOpts(async (mail) => void sent.push(mail)),
    );
    const socket = new FakeInviteSocket();
    bind(socket, room.code, 1);
    server.connect(socket);
    expect(await socket.invite('  Friend@Example.com  ')).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('Friend@Example.com');
    expect(sent[0]?.subject).toContain(room.code);
    expect(sent[0]?.html).toContain(`https://werewolf.example/?room=${room.code}`);
  });

  it('acks INVITE_BUSY while one send is in flight, per room:seat', async () => {
    const room = lobbyWithTwo();
    const gates: Array<(value?: void) => void> = [];
    const sendImpl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    );
    const server = new FakeInviteServer();
    attachInvites(server, registryOf(room), inviteOpts(sendImpl));
    const first = new FakeInviteSocket();
    bind(first, room.code, 1);
    server.connect(first);
    const firstAck = first.invite('friend@example.com');
    const second = new FakeInviteSocket();
    bind(second, room.code, 1);
    server.connect(second);
    expect(await second.invite('other@example.com')).toEqual({ error: 'INVITE_BUSY' });
    // A different seat's budget is its own: seat 2's send completes while
    // seat 1's is still in flight.
    const seatTwo = new FakeInviteSocket();
    bind(seatTwo, room.code, 2);
    server.connect(seatTwo);
    const seatTwoAck = seatTwo.invite('other@example.com');
    gates[1]?.();
    expect(await seatTwoAck).toEqual({ ok: true });
    gates[0]?.();
    expect(await firstAck).toEqual({ ok: true });
    expect(sendImpl).toHaveBeenCalledTimes(2);
  });

  it('acks INVITE_RATE_LIMITED beyond the lobby budget', async () => {
    const room = lobbyWithTwo();
    const sendImpl = vi.fn(async () => {});
    const server = new FakeInviteServer();
    attachInvites(server, registryOf(room), inviteOpts(sendImpl, { maxInvitesPerLobby: 2 }));
    const socket = new FakeInviteSocket();
    bind(socket, room.code, 1);
    server.connect(socket);
    expect(await socket.invite('a@example.com')).toEqual({ ok: true });
    expect(await socket.invite('b@example.com')).toEqual({ ok: true });
    expect(await socket.invite('c@example.com')).toEqual({ error: 'INVITE_RATE_LIMITED' });
    expect(sendImpl).toHaveBeenCalledTimes(2);
    // The in-flight gate does not consume the budget — busy is not a spend.
  });

  it('limits the default budget to ten sends per room:seat', async () => {
    const room = lobbyWithTwo();
    const sendImpl = vi.fn(async () => {});
    const server = new FakeInviteServer();
    attachInvites(server, registryOf(room), inviteOpts(sendImpl));
    const socket = new FakeInviteSocket();
    bind(socket, room.code, 1);
    server.connect(socket);
    for (let i = 0; i < 10; i++) {
      expect(await socket.invite(`friend${i}@example.com`)).toEqual({ ok: true });
    }
    expect(await socket.invite('friend11@example.com')).toEqual({ error: 'INVITE_RATE_LIMITED' });
    expect(sendImpl).toHaveBeenCalledTimes(10);
  });

  it('acks INVITE_ERROR when the provider fails and recovers for the next send', async () => {
    const room = lobbyWithTwo();
    let fail = true;
    const server = new FakeInviteServer();
    attachInvites(
      server,
      registryOf(room),
      inviteOpts(async () => {
        if (fail) throw new Error('smtp down');
      }),
    );
    const socket = new FakeInviteSocket();
    bind(socket, room.code, 1);
    server.connect(socket);
    expect(await socket.invite('friend@example.com')).toEqual({ error: 'INVITE_ERROR' });
    fail = false; // the finally cleared inflight — the seat may try again
    expect(await socket.invite('friend@example.com')).toEqual({ ok: true });
  });

  it('exposes the capability hint when a sender resolves', () => {
    const room = lobbyWithTwo();
    const configured = new FakeInviteServer();
    expect(
      attachInvites(
        configured,
        registryOf(room),
        inviteOpts(async () => {}),
      ).available,
    ).toBe(true);
    const bare = new FakeInviteServer();
    expect(attachInvites(bare, registryOf(room)).available).toBe(false);
    expect(
      attachInvites(bare, registryOf(room), { baseUrl: 'https://x', from: 'a@b.c' }).available,
    ).toBe(false); // base URL alone is not a sender
  });
});

describe('room:invite phase gate and seat budgets', () => {
  it('acks GAME_RUNNING for a mid-game invite before any budget state is touched', async () => {
    const room = fixedRoom();
    for (let i = 0; i < 12; i++) room.join();
    const sendImpl = vi.fn(async () => {});
    const server = new FakeInviteServer();
    attachInvites(server, registryOf(room), inviteOpts(sendImpl, { maxInvitesPerLobby: 1 }));
    const socket = new FakeInviteSocket();
    bind(socket, room.code, 1);
    server.connect(socket);
    expect(await socket.invite('friend@example.com')).toEqual({ ok: true }); // budget 1/1
    room.start();
    // The phase gate precedes the budget check: a maxed budget would ack
    // INVITE_RATE_LIMITED if the budget were consulted first.
    expect(await socket.invite('other@example.com')).toEqual({ error: 'GAME_RUNNING' });
    expect(sendImpl).toHaveBeenCalledTimes(1); // no send left the lobby
  });

  it('gives a freed seat a fresh budget: clearSeatBudget on quit, rejoin, send', async () => {
    const room = lobbyWithTwo();
    room.join(); // seat 3
    const sendImpl = vi.fn(async () => {});
    const server = new FakeInviteServer();
    const attachment = attachInvites(
      server,
      registryOf(room),
      inviteOpts(sendImpl, { maxInvitesPerLobby: 1 }),
    );
    const first = new FakeInviteSocket();
    bind(first, room.code, 3);
    server.connect(first);
    expect(await first.invite('a@example.com')).toEqual({ ok: true });
    expect(await first.invite('b@example.com')).toEqual({ error: 'INVITE_RATE_LIMITED' });
    // The gateway frees the seat on leave/removeBot and clears that seat's
    // budget — the budget belongs to the occupant, not the seat number.
    room.leave(3);
    attachment.clearSeatBudget(room.code, 3);
    const second = new FakeInviteSocket();
    bind(second, room.code, 3);
    server.connect(second);
    expect(await second.invite('c@example.com')).toEqual({ ok: true });
    expect(sendImpl).toHaveBeenCalledTimes(2);
  });
});
