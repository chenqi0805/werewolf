import { describe, expect, it } from 'vitest';
import type { Role, Seat } from '@werewolf/engine';
import { RoomError } from '../errors';
import type { Room } from '../room';
import { viewFor } from '../view';
import { ALL_SEATS, fixedRoom } from './fixtures';
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
