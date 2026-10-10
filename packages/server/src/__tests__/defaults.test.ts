import { describe, expect, it } from 'vitest';
import type { GameAction } from '@werewolf/engine';
import { DEFAULT_TIMERS, clockKey, defaultActionsFor } from '../defaults';
import { fixedRoom } from './fixtures';
import * as drv from './drivers';

function types(actions: GameAction[]): string[] {
  return actions.map((a) => a.type);
}

function startedRoom() {
  const room = fixedRoom();
  for (let i = 0; i < 12; i++) room.join();
  room.start();
  return room;
}

describe('defaultActionsFor', () => {
  it('defaults the wolf step to an empty knife for every living wolf', () => {
    const room = startedRoom();
    const actions = defaultActionsFor(room.state);
    expect(types(actions)).toEqual(['WOLF_KILL', 'WOLF_KILL', 'WOLF_KILL', 'WOLF_KILL']);
    expect(actions.every((a) => a.type === 'WOLF_KILL' && a.target === null)).toBe(true);
  });

  it('injects only the missing wolf votes', () => {
    const room = startedRoom();
    room.applyPlayerAction({ type: 'WOLF_KILL', actor: 1, target: 5 });
    room.applyPlayerAction({ type: 'WOLF_KILL', actor: 4, target: 5 });
    const actions = defaultActionsFor(room.state);
    expect(types(actions)).toEqual(['WOLF_KILL', 'WOLF_KILL']);
    expect(actions.every((a) => a.type === 'WOLF_KILL' && (a.actor === 2 || a.actor === 3))).toBe(
      true,
    );
  });

  it('passes the witch and seer steps, and proceeds through pacing phases', () => {
    const room = startedRoom();
    drv.nightKill(room, 5);
    expect(clockKey(room.state)).toBe('night:witch');
    expect(types(defaultActionsFor(room.state))).toEqual(['WITCH_PASS']);
    drv.witchPass(room);
    expect(clockKey(room.state)).toBe('night:seer');
    expect(types(defaultActionsFor(room.state))).toEqual(['SEER_PASS']);

    drv.seerCheck(room, 1); // -> day 1, sheriff-signup
    expect(types(defaultActionsFor(room.state))).toEqual(['PROCEED']);
  });

  it('abstains for every non-voting ballot seat, sheriff and exile alike', () => {
    const room = startedRoom();
    drv.nightKill(room, 5);
    drv.witchPass(room);
    drv.seerCheck(room, 1);
    drv.holdElection(room, [9, 10], 9);
    // Dawn-announce after the election: pacing.
    expect(types(defaultActionsFor(room.state))).toEqual(['PROCEED']);
    room.proceed(); // announce 5 -> last-words
    expect(types(defaultActionsFor(room.state))).toEqual(['PROCEED']);
    drv.lastWords(room, 5);
    drv.runSpeech(room);

    // Exile vote: everyone alive except the unrevealed-yet electorate rules.
    const actions = defaultActionsFor(room.state);
    expect(actions.every((a) => a.type === 'EXILE_VOTE' && a.target === null)).toBe(true);
    const electorate = room.state.vote?.electorate ?? [];
    expect(new Set(actions.map((a) => (a.type === 'EXILE_VOTE' ? a.actor : -1)))).toEqual(
      new Set(electorate),
    );
  });

  it('injects the sheriff direction only while the floor order is unset', () => {
    const room = startedRoom();
    drv.nightKill(room, 5);
    drv.witchPass(room);
    drv.seerCheck(room, 1);
    drv.holdElection(room, [9, 10], 9);
    room.proceed();
    drv.lastWords(room, 5);
    // Speech begins: order is null until the sheriff chooses.
    const actions = defaultActionsFor(room.state);
    expect(types(actions)).toEqual(['SET_SPEECH_DIRECTION']);
    if (actions[0]?.type !== 'SET_SPEECH_DIRECTION') return; // narrowed above
    expect(actions[0].actor).toBe(9);
    expect(actions[0].direction).toBe('cw');
  });
});

describe('DEFAULT_TIMERS', () => {
  it('gives the night steps longer deliberation clocks, day clocks untouched', () => {
    expect(DEFAULT_TIMERS['night:wolf']).toBe(60_000);
    expect(DEFAULT_TIMERS['night:witch']).toBe(60_000);
    expect(DEFAULT_TIMERS['night:seer']).toBe(45_000);
    // Scope guard: only the night keys moved — day pacing stays standard.
    expect(DEFAULT_TIMERS['sheriff-signup']).toBe(20_000);
    expect(DEFAULT_TIMERS.speech).toBe(75_000);
    expect(DEFAULT_TIMERS['exile-vote']).toBe(45_000);
    expect(DEFAULT_TIMERS['hunter-shot']).toBe(20_000);
    expect(DEFAULT_TIMERS['badge-pass']).toBe(15_000);
  });
});

describe('Room.tick — injected defaults advance the game', () => {
  it('resolves a fully abstained exile vote into the next night', () => {
    const room = startedRoom();
    drv.nightKill(room, 5);
    drv.witchPass(room);
    drv.seerCheck(room, 1);
    room.proceed(); // void election -> dawn
    room.proceed(); // announce 5 -> last words
    drv.lastWords(room, 5);
    drv.runSpeech(room); // -> exile-vote

    const applied = room.tick();
    expect(applied).not.toBeNull();
    expect(room.state.phase).toBe('night');
    expect(room.state.dayNumber).toBe(2);
  });

  it('passes a vanished hunter through the shot window', () => {
    const room = startedRoom();
    // Night 1 as before; day 1 voids the election (no signups).
    drv.nightKill(room, 5);
    drv.witchPass(room);
    drv.seerCheck(room, 1);
    room.proceed();
    room.proceed(); // announce 5 -> last words
    drv.lastWords(room, 5);
    drv.runSpeech(room);
    room.tick(); // abstained exile -> night 2

    // Night 2: wolves kill the hunter; witch and seer pass by injection too.
    drv.nightKill(room, 11);
    drv.witchPass(room);
    drv.seerCheck(room, 2);
    room.proceed(); // announce 11 -> hunter-shot
    expect(room.state.phase).toBe('hunter-shot');

    const applied = room.tick();
    expect(applied).not.toBeNull();
    expect(room.state.phase).not.toBe('hunter-shot'); // passed, dawn drained
    expect(room.state.players[11]?.alive).toBe(false);
  });

  it('destroys the badge when the holder vanishes at badge-pass', () => {
    const room = startedRoom();
    // Sheriff 9 elected, then killed on night 2.
    drv.nightKill(room, 5);
    drv.witchPass(room);
    drv.seerCheck(room, 1);
    drv.holdElection(room, [9, 10], 9);
    room.proceed();
    drv.lastWords(room, 5);
    drv.runSpeech(room);
    room.tick(); // abstained exile -> night 2
    drv.nightKill(room, 9); // the sheriff dies
    drv.witchPass(room);
    drv.seerCheck(room, 2);
    room.proceed(); // announce 9 -> badge-pass
    expect(room.state.phase).toBe('badge-pass');

    const applied = room.tick();
    expect(applied).not.toBeNull();
    expect(room.state.players[9]?.hasBadge).toBe(false);
    expect(room.state.phase).not.toBe('badge-pass'); // destroyed, dawn drained
  });
});
