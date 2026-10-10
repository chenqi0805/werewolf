import { createGame, type Seat } from '@werewolf/engine';
import { describe, expect, it } from 'vitest';
import { RoomError } from '../errors';
import { BOT_NICKNAMES } from '../botNames';
import { hashToken } from '../ids';
import { Room, type SeatIdentity } from '../room';
import { STANDARD, ALL_SEATS } from './fixtures';

/**
 * Bot seat identity at the Room level: seating, removal, token reminting,
 * and the restore path. The gateway-level behavior (ack payloads, runner
 * spawning, wire errors) lives in the integration suite.
 */

function fullRoom(): { room: Room; start: () => void } {
  const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
  for (let i = 1; i < 12; i++) room.join(); // seats 2..12; seat 1 auto-seated
  return { room, start: () => room.start() };
}

describe('addBot', () => {
  it('seats the lowest free seat with a pool nickname and a working token', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    room.join(); // human takes seat 1
    const bot = room.addBot();
    expect(bot.seat).toBe(2);
    expect(bot.name).toBe(BOT_NICKNAMES[0]);
    expect(room.reattach(bot.token)).toBe(2); // the raw token rejoins the seat
  });

  it('draws distinct nicknames per bot and frees them on removal', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    const first = room.addBot();
    const second = room.addBot();
    expect(second.seat).toBe(2);
    expect(second.name).not.toBe(first.name);
    room.removeBot(first.seat);
    const third = room.addBot();
    expect(third.seat).toBe(first.seat);
    expect(third.name).toBe(first.name); // the freed name is reused
  });

  it('fills the room with bots like humans and rejects the 13th seat', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    for (let i = 0; i < 12; i++) room.addBot();
    expect(room.occupiedSeats().size).toBe(ALL_SEATS.length);
    expect(() => room.addBot()).toThrowError(RoomError);
    expect(() => room.join()).toThrowError(RoomError);
  });

  it('is lobby-only once the game has started', () => {
    const { room, start } = fullRoom();
    const bot = room.addBot();
    start();
    expect(() => room.addBot()).toThrowError(RoomError);
    expect(() => room.removeBot(bot.seat)).toThrowError(RoomError);
  });
});

describe('removeBot', () => {
  it('frees the seat and kills the token', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    const bot = room.addBot();
    room.removeBot(bot.seat);
    expect(room.isBotSeat(bot.seat)).toBe(false);
    expect(() => room.reattach(bot.token)).toThrowError(RoomError);
    expect(room.join().seat).toBe(bot.seat); // the seat is reusable
  });

  it('rejects a human seat with NOT_A_BOT', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    room.join();
    expect(() => room.removeBot(1)).toThrowError(RoomError);
  });

  it('clears bot identity when a human quit path frees a bot seat', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    const bot = room.addBot();
    room.leave(bot.seat); // defensive: the leave path also clears the name
    expect(room.isBotSeat(bot.seat)).toBe(false);
  });
});

describe('remintBotToken', () => {
  it('mints a working token for a bot seat and invalidates the old raw token', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    const bot = room.addBot();
    const fresh = room.remintBotToken(bot.seat);
    expect(room.reattach(fresh)).toBe(bot.seat);
    expect(() => room.reattach(bot.token)).toThrowError(RoomError);
  });

  it('never remints a human seat', () => {
    const room = new Room({ code: 'TEST', assignments: [...STANDARD] });
    room.join();
    expect(() => room.remintBotToken(1)).toThrowError(RoomError);
  });
});

describe('restored bot seats', () => {
  it('adopts hash-only seats, names bots from the pool in seat order, and remints', () => {
    const state = createGame([...STANDARD]);
    const room = new Room({
      code: 'TEST',
      restored: {
        state,
        seats: new Map<Seat, SeatIdentity>([
          [3, { tokenHash: hashToken('raw3'), name: '' }],
          [7, { tokenHash: hashToken('raw7'), name: '' }],
        ]),
        bots: new Set([7, 3]),
      },
    });
    expect(room.botSeats().get(3)).toBe(BOT_NICKNAMES[0]); // lowest seat first
    expect(room.botSeats().get(7)).toBe(BOT_NICKNAMES[1]);
    expect(room.reattach('raw3')).toBe(3); // stored hashes still reattach
    const token = room.remintBotToken(3);
    expect(room.reattach(token)).toBe(3);
    expect(() => room.remintBotToken(1)).toThrowError(RoomError);
  });

  it('treats restored seats as human when no bots set is given', () => {
    const state = createGame([...STANDARD]);
    const room = new Room({
      code: 'TEST',
      restored: {
        state,
        seats: new Map<Seat, SeatIdentity>([[3, { tokenHash: 'hash3', name: '' }]]),
      },
    });
    expect(room.isBotSeat(3)).toBe(false);
    expect(room.botSeats().size).toBe(0);
  });
});
