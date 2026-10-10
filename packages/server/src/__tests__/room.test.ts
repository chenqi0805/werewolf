import { describe, expect, it } from 'vitest';
import type { GameAction, Role, Seat } from '@werewolf/engine';
import { RoomError } from '../errors';
import { hashToken } from '../ids';
import { Room, type SeatIdentity } from '../room';
import { viewFor } from '../view';
import { ALL_SEATS, fixedRoom, STANDARD } from './fixtures';
import * as drv from './drivers';

/** Server-only event types — the same rule the view tests enforce. */
const SERVER_TYPES = new Set([
  'WOLF_KILL_VOTE',
  'KILL_TARGET_SET',
  'WITCH_HEALED',
  'WITCH_POISONED',
  'WITCH_PASSED',
  'SEER_PASSED',
  'DEATH_RESOLVED',
  'SPEECH_ENDED',
]);

function makeFullRoom(): Room {
  const room = fixedRoom();
  for (let i = 0; i < 12; i++) room.join();
  return room;
}

function revealedFromLog(room: Room): Map<Seat, Role> {
  const revealed = new Map<Seat, Role>();
  for (const e of room.state.log) {
    if (e.type === 'IDIOT_REVEALED') revealed.set(e.seat, 'idiot');
    if (e.type === 'HUNTER_SHOT') revealed.set(e.shooter, 'hunter');
  }
  return revealed;
}

/**
 * Sweeps the current state: for every seat and a spectator, no view may
 * contain a role that viewer is not entitled to (own card, living wolf pack,
 * publicly flipped cards, or the game-over reveal), and no view log may
 * contain server-only or foreign-private events.
 */
function assertFog(room: Room): void {
  const over = room.isFinished();
  const revealed = revealedFromLog(room);
  for (const seat of ALL_SEATS) {
    const view = viewFor(room.state, seat);
    const youRole = view.players.find((r) => r.seat === seat)?.role ?? null;
    for (const row of view.players) {
      if (row.role === null) continue;
      const allowed =
        row.seat === seat ||
        over ||
        revealed.get(row.seat) === row.role ||
        (youRole === 'werewolf' && row.role === 'werewolf');
      expect(allowed, `seat ${seat} saw seat ${row.seat} as ${row.role}`).toBe(true);
    }
    expect(
      view.log.every((e) => !SERVER_TYPES.has(e.type)),
      `server events leaked into seat ${seat}'s log`,
    ).toBe(true);
    for (const e of view.log) {
      if (e.type === 'SEER_CHECKED') {
        expect(e.actor === seat, `SEER_CHECKED reached seat ${seat}`).toBe(true);
      }
    }
  }
  // Spectators: strictly public.
  const spectator = viewFor(room.state, null);
  expect(spectator.log.every((e) => e.type !== 'SEER_CHECKED')).toBe(true);
  // A living wolf keeps pack knowledge throughout.
  if (!over && room.state.players[1]?.alive) {
    const wolfView = viewFor(room.state, 1);
    for (const s of [2, 3, 4]) {
      expect(wolfView.players.find((r) => r.seat === s)?.role).toBe('werewolf');
    }
  }
}

describe('Room lifecycle', () => {
  it('seats players in join order with unique session tokens', () => {
    const room = fixedRoom();
    const tokens = new Set<string>();
    for (let i = 1; i <= 12; i++) {
      const { seat, sessionToken } = room.join();
      expect(seat).toBe(i);
      tokens.add(sessionToken);
    }
    expect(tokens.size).toBe(12);
    expect(room.isFull()).toBe(true);
  });

  it('rejects a 13th seat with ROOM_FULL', () => {
    const room = makeFullRoom();
    expect(() => room.join()).toThrowError(RoomError);
    expect(() => room.join()).toThrowError(/ROOM_FULL|Every seat/);
  });

  it('rejects start before the room is full', () => {
    const room = fixedRoom();
    room.join();
    expect(() => room.start()).toThrowError(RoomError);
  });

  it('rejects late joins once started, and double start', () => {
    const room = makeFullRoom();
    room.start();
    expect(() => room.join()).toThrowError(RoomError);
    expect(() => room.join()).toThrowError(/GAME_RUNNING|already running/);
    expect(() => room.start()).toThrowError(/ALREADY_STARTED|already started/);
  });

  it('reattaches a seat from its bearer token and rejects bad tokens', () => {
    const room = fixedRoom();
    const { seat, sessionToken } = room.join();
    room.join();
    expect(room.reattach(sessionToken)).toBe(seat);
    expect(() => room.reattach('forged-token')).toThrowError(/BAD_TOKEN|No seat/);
  });
});

describe('seat display names', () => {
  it('stores the name chosen at the door and reads it back per seat', () => {
    const room = fixedRoom();
    const a = room.join('阿明');
    const b = room.join('小美');
    room.join();
    expect(room.seatName(a.seat)).toBe('阿明');
    expect(room.seatName(b.seat)).toBe('小美');
    expect(room.seatNames()).toEqual(
      new Map<Seat, string>([
        [a.seat, '阿明'],
        [b.seat, '小美'],
      ]),
    );
  });

  it('defaults to no name — the seat-label fallback', () => {
    const room = fixedRoom();
    const a = room.join();
    expect(room.seatName(a.seat)).toBe('');
    expect(room.seatNames().size).toBe(0);
  });

  it('frees the name with the seat on leave', () => {
    const room = fixedRoom();
    const a = room.join('阿明');
    room.leave(a.seat);
    const next = room.join();
    expect(next.seat).toBe(a.seat); // the seat is reused…
    expect(room.seatName(next.seat)).toBe(''); // …but the old name is not.
  });

  it('restores names with the seat records across a restore', () => {
    const source = fixedRoom();
    const a = source.join('阿明');
    const restored = new Room({
      code: source.code,
      restored: {
        state: source.state,
        seats: new Map<Seat, SeatIdentity>([
          [a.seat, { tokenHash: hashToken(a.sessionToken), name: '阿明' }],
          [2, { tokenHash: hashToken('other-raw'), name: '小美' }],
        ]),
      },
    });
    expect(restored.seatName(a.seat)).toBe('阿明');
    expect(restored.seatName(2)).toBe('小美');
    // The token path is unchanged by the shape change.
    expect(restored.reattach(a.sessionToken)).toBe(a.seat);
  });
});

describe('scripted full game — deterministic deck', () => {
  it('plays to a wolf win with zero role leakage at every step', () => {
    const room = makeFullRoom();
    room.start();
    assertFog(room);

    // Night 1 — wolves kill 5, witch passes, seer checks a wolf.
    drv.nightKill(room, 5);
    assertFog(room);
    // The witch alone sees the kill target while deciding.
    expect(viewFor(room.state, 10).you.witchPotions?.killTarget).toBe(5);
    for (const seat of [1, 9, 11]) {
      expect(viewFor(room.state, seat).you.witchPotions).toBeUndefined();
    }
    drv.witchPass(room);
    assertFog(room);
    expect(viewFor(room.state, 10).you.witchPotions?.killTarget).toBeUndefined();
    drv.seerCheck(room, 1);
    assertFog(room);

    // Day 1 — sheriff election: 9 and 10 run, 9 wins the badge.
    drv.holdElection(room, [9, 10], 9);
    assertFog(room);
    expect(room.state.players[9]?.hasBadge).toBe(true);

    // Dawn announces seat 5, last words, speech round, exile the idiot.
    room.proceed(); // announce 5 -> last-words
    assertFog(room);
    drv.lastWords(room, 5);
    assertFog(room);
    drv.runSpeech(room);
    assertFog(room);
    drv.unanimousExile(room, 12); // the idiot flips and survives
    assertFog(room);
    expect(room.state.players[12]?.revealedIdiot).toBe(true);
    expect(room.state.phase).toBe('night');

    // Night 2 — wolves kill the hunter; he shoots the witch at dawn.
    drv.nightKill(room, 11);
    drv.witchPass(room);
    drv.seerCheck(room, 2);
    assertFog(room);
    room.proceed(); // announce 11 -> hunter-shot
    expect(room.state.phase).toBe('hunter-shot');
    room.applyPlayerAction({ type: 'HUNTER_SHOOT', actor: 11, target: 10 });
    assertFog(room);
    expect(room.state.players[10]?.alive).toBe(false);
    drv.runSpeech(room);
    assertFog(room);
    drv.unanimousExile(room, 1); // first wolf exiled -> night 3
    assertFog(room);

    // Night 3 — wolves kill the sheriff; the badge moves to seat 6.
    drv.nightKill(room, 9);
    // Deaths resolve at dawn, so tonight's doomed seer still gets his wake —
    // the engine's ruling; drive the step before the night completes.
    drv.seerCheck(room, 3);
    assertFog(room);
    room.proceed(); // announce 9 -> badge-pass
    expect(room.state.phase).toBe('badge-pass');
    room.applyPlayerAction({ type: 'SHERIFF_PASS', actor: 9, target: 6 });
    assertFog(room);
    expect(room.state.players[6]?.hasBadge).toBe(true);
    expect(room.state.players[9]?.hasBadge).toBe(false);
    drv.runSpeech(room);
    assertFog(room);
    drv.unanimousExile(room, 2);
    assertFog(room);

    // Night 4 — the new sheriff dies; this time the badge is destroyed.
    drv.nightKill(room, 6);
    room.proceed();
    expect(room.state.phase).toBe('badge-pass');
    room.applyPlayerAction({ type: 'SHERIFF_PASS', actor: 6, target: null });
    assertFog(room);
    expect(room.state.players[6]?.hasBadge).toBe(false);
    drv.runSpeech(room);
    assertFog(room);
    drv.unanimousExile(room, 3);
    assertFog(room);

    // Night 5 — the last wolf kills; the table exiles the final villager.
    drv.nightKill(room, 7);
    room.proceed();
    drv.runSpeech(room);
    assertFog(room);
    drv.unanimousExile(room, 8);
    assertFog(room);

    // 屠边 via villagers: 5, 6, 7, 8 are all dead.
    expect(room.state.phase).toBe('game-over');
    expect(room.state.winner).toBe('wolves');
    // Full reveal at game-over — even to spectators.
    const spectator = viewFor(room.state, null);
    expect(spectator.players.every((r) => r.role !== null)).toBe(true);
  });

  it('keeps vote tallies and kill targets out of every view', () => {
    const room = makeFullRoom();
    room.start();
    drv.nightKill(room, 5);
    drv.witchPass(room);
    drv.seerCheck(room, 1);
    room.proceed(); // void election
    room.proceed(); // announce 5
    drv.lastWords(room, 5);
    drv.runSpeech(room);
    // Half the table votes; nothing about the ballots may appear in views.
    const electorate = room.state.vote?.electorate ?? [];
    for (const voter of electorate.slice(0, Math.floor(electorate.length / 2))) {
      room.applyPlayerAction({ type: 'EXILE_VOTE', actor: voter, target: 6 });
    }
    for (const seat of ALL_SEATS) {
      const raw = JSON.stringify(viewFor(room.state, seat));
      expect(raw.includes('"votes"')).toBe(false);
      expect(raw.includes('"killTarget"')).toBe(false);
      expect(raw.includes('"wolfVotes"')).toBe(false);
    }
  });
});

describe('lobby seat release', () => {
  it('frees the seat for the next joiner', () => {
    const room = fixedRoom();
    const first = room.join();
    room.leave(first.seat);
    expect(room.seatedCount).toBe(0);
    expect(room.join().seat).toBe(first.seat);
  });

  it('exposes occupancy through occupiedSeats', () => {
    const room = fixedRoom();
    const a = room.join();
    room.join();
    expect(room.occupiedSeats()).toEqual(new Set([a.seat, 2]));
    room.leave(a.seat);
    expect(room.occupiedSeats()).toEqual(new Set([2]));
  });

  it('rejects a leave once the game has started — mid-game semantics unchanged', () => {
    const room = makeFullRoom();
    room.start();
    try {
      room.leave(1);
      expect.unreachable('leave after start must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError);
      expect((error as RoomError).code).toBe('ALREADY_STARTED');
    }
  });

  it('rejects a leave for a seat no session holds', () => {
    const room = fixedRoom();
    try {
      room.leave(5);
      expect.unreachable('leaving an unheld seat must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError);
      expect((error as RoomError).code).toBe('NO_SEAT');
    }
  });
});

describe('Room persistence rollback (SRV-4)', () => {
  it('rolls memory back to the pre-action state when the onAction hook throws', () => {
    const appended: GameAction[] = [];
    let failNextAppend = false;
    const room = new Room({
      code: 'ROLLBACK',
      assignments: [...STANDARD],
      hooks: {
        onAction: (_room, action) => {
          if (failNextAppend) throw new Error('disk full (simulated store failure)');
          appended.push(action);
        },
      },
    });
    for (let i = 0; i < 12; i++) room.join();
    room.start();

    // Mid-game position: the first wolf's knife is recorded, the second
    // wolf's ballot is where the append will fail.
    const wolves = Object.values(room.state.players)
      .filter((p) => p.alive && p.role === 'werewolf')
      .map((p) => p.seat)
      .sort((a, b) => a - b);
    const firstWolf = wolves[0];
    const secondWolf = wolves[1];
    if (firstWolf === undefined || secondWolf === undefined) {
      throw new Error('fixed deck must deal at least two wolves');
    }
    room.applyPlayerAction({ type: 'WOLF_KILL', actor: firstWolf, target: 5 });
    const before = JSON.stringify(room.state);
    const viewsBefore = ALL_SEATS.map((s) => JSON.stringify(viewFor(room.state, s)));

    failNextAppend = true;
    expect(() =>
      room.applyPlayerAction({ type: 'WOLF_KILL', actor: secondWolf, target: 5 }),
    ).toThrow('disk full (simulated store failure)');

    // The throw surfaces to the caller (the gateway turns it into a
    // game:error for the actor) and the room's memory is byte-identical to
    // before the action — the state and every seat's fog-of-war view.
    expect(JSON.stringify(room.state)).toBe(before);
    ALL_SEATS.forEach((seat, i) => {
      expect(JSON.stringify(viewFor(room.state, seat))).toBe(viewsBefore[i]);
    });

    // Recovery: the next successful action appends after the last recorded
    // one — the failed append never entered the stream.
    failNextAppend = false;
    room.applyPlayerAction({ type: 'WOLF_KILL', actor: secondWolf, target: 5 });
    expect(appended.map((a) => a.type)).toEqual(['START_GAME', 'WOLF_KILL', 'WOLF_KILL']);
  });
});
