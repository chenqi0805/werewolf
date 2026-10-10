import { describe, expect, it } from 'vitest';
import type { GameAction } from '@werewolf/engine';
import { campOf } from '@werewolf/engine';
import { WOLF_KING_STANDARD } from './fixtures';
import { clockKey, defaultActionsFor } from '../defaults';
import { Room } from '../room';

function types(actions: GameAction[]): string[] {
  return actions.map((a) => a.type);
}

/** Living wolf-camp seats (狼人 + 白狼王) — the kill electorate on this board. */
function livingWolfCamp(room: Room): number[] {
  return Object.values(room.state.players)
    .filter((p) => p.alive && campOf(p.role) === 'wolf')
    .map((p) => p.seat)
    .sort((a, b) => a - b);
}

function startedWolfKingRoom(): Room {
  const room = new Room({
    code: 'TESTWK',
    assignments: [...WOLF_KING_STANDARD],
    boardId: 'wolfking',
  });
  for (let i = 0; i < 12; i++) room.join();
  room.start();
  return room;
}

describe('defaultActionsFor — wolfking board', () => {
  it('passes the guard first, then abstains the whole wolf camp to a 空刀', () => {
    const room = startedWolfKingRoom();
    expect(room.state.night?.guardTurn).toBe('pending');
    // The guard's window rides the night:wolf clock: the wire step stays
    // 'wolf' while he pends, and armTimer re-arms after every broadcast, so
    // the wolves still get a fresh window once he acts. A dedicated
    // night:guard key would extend the WEREWOLF_TIMERS surface for one knob.
    expect(clockKey(room.state)).toBe('night:wolf');
    expect(types(defaultActionsFor(room.state))).toEqual(['GUARD_PASS']);
    room.applyPlayerAction({ type: 'GUARD_PASS', actor: 12 });
    expect(room.state.night?.guardTurn).toBe('done');
    // The king votes the kill with his pack — a literal-wolf default would
    // stall the night on an AFK king under the wolf clock.
    const actions = defaultActionsFor(room.state);
    expect(types(actions)).toEqual(['WOLF_KILL', 'WOLF_KILL', 'WOLF_KILL', 'WOLF_KILL']);
    expect(new Set(actions.map((a) => (a.type === 'WOLF_KILL' ? a.actor : -1)))).toEqual(
      new Set(livingWolfCamp(room)),
    );
  });

  it('injects no guard default when 空守 is off — the guard simply waits', () => {
    const room = startedWolfKingRoom();
    // EngineConfig is plain JSON on the state (the engine's own tests mutate
    // it the same way); flipping the knob exercises the no-neutral-default
    // branch without a second fixture room.
    room.state.config.guardEmptyProtect = false;
    expect(types(defaultActionsFor(room.state))).toEqual([]);
    // The wolves stay blocked behind the guard: injecting the kill batch now
    // would be rejected NOT_YOUR_TURN and freeze the phase — the pass must
    // come first or not at all.
    room.applyPlayerAction({ type: 'GUARD_PROTECT', actor: 12, target: 9 });
    expect(types(defaultActionsFor(room.state))).toEqual([
      'WOLF_KILL',
      'WOLF_KILL',
      'WOLF_KILL',
      'WOLF_KILL',
    ]);
  });

  it('passes the 白狼王 settlement window instead of a hunter pass', () => {
    const room = startedWolfKingRoom();
    // Night 1: guard pass, camp knife on villager 7, witch and seer decline.
    room.applyPlayerAction({ type: 'GUARD_PASS', actor: 12 });
    for (const w of livingWolfCamp(room)) {
      room.applyPlayerAction({ type: 'WOLF_KILL', actor: w, target: 7 });
    }
    room.applyPlayerAction({ type: 'WITCH_PASS', actor: 10 });
    room.applyPlayerAction({ type: 'SEER_PASS', actor: 9 });
    room.proceed(); // close empty signup -> void election
    room.proceed(); // announce 7 -> last words
    room.applyPlayerAction({ type: 'SPEAK', actor: 7, text: 'last words' });
    room.proceed(); // -> speech
    for (let i = 0; i < (room.state.speech?.order ?? []).length; i++) {
      room.proceed(); // every slot passes silently
    }
    // Unanimous exile of the king -> his settlement window opens.
    for (const voter of room.state.vote?.electorate ?? []) {
      room.applyPlayerAction({ type: 'EXILE_VOTE', actor: voter, target: 4 });
    }
    expect(room.state.phase).toBe('hunter-shot');
    expect(room.state.resolution?.queue[0]?.destructWindow).toBe(true);
    expect(clockKey(room.state)).toBe('hunter-shot');

    expect(types(defaultActionsFor(room.state))).toEqual(['WOLF_KING_PASS']);
  });
});
