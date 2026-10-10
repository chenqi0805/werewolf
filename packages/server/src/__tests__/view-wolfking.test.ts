import { describe, expect, it } from 'vitest';
import type { GameAction, GameState, Seat } from '@werewolf/engine';
import { applyAction, campOf, createGame } from '@werewolf/engine';
import { viewFor } from '../view';
import { STANDARD, WOLF_KING_STANDARD } from './fixtures';

function apply(state: GameState, action: GameAction): GameState {
  return applyAction(state, action).state;
}

function wkGame(): GameState {
  return apply(createGame(WOLF_KING_STANDARD, 'wolfking'), { type: 'START_GAME' });
}

/** Living wolf-camp seats (狼人 + 白狼王) in seat order. */
function livingWolfCamp(s: GameState): Seat[] {
  return Object.values(s.players)
    .filter((p) => p.alive && campOf(p.role) === 'wolf')
    .map((p) => p.seat);
}

/** Quiet wolfking night: guard passes, the camp abstains (空刀), witch and seer decline. */
function quietNight(s: GameState): GameState {
  let out = s;
  if (out.night?.guardTurn === 'pending') out = apply(out, { type: 'GUARD_PASS', actor: 12 });
  for (const w of livingWolfCamp(out)) {
    out = apply(out, { type: 'WOLF_KILL', actor: w, target: null });
  }
  if (out.players[10]?.alive) out = apply(out, { type: 'WITCH_PASS', actor: 10 });
  if (out.players[9]?.alive) out = apply(out, { type: 'SEER_PASS', actor: 9 });
  return out;
}

/** Close an empty sheriff signup (void election), then PROCEED to the speech phase. */
function toSpeech(): GameState {
  let s = apply(quietNight(wkGame()), { type: 'PROCEED' });
  let guard = 0;
  while (s.phase === 'dawn-announce' || s.phase === 'last-words') {
    if (++guard > 40) throw new Error('day open did not settle');
    s = apply(s, { type: 'PROCEED' });
  }
  return s;
}

/** Quiet night, void election, speeches pass, unanimous exile of the 白狼王. */
function toKingSettlement(): GameState {
  let s = toSpeech();
  const order = s.speech?.order;
  if (!order) throw new Error(`speech order missing in phase ${s.phase}`);
  for (let i = 0; i < order.length; i++) s = apply(s, { type: 'PROCEED' });
  for (const voter of s.vote?.electorate ?? []) {
    s = apply(s, { type: 'EXILE_VOTE', actor: voter, target: 4 });
  }
  return s;
}

describe('viewFor — wolfking board projections', () => {
  it('labels the view with the dealt board', () => {
    expect(viewFor(createGame(WOLF_KING_STANDARD, 'wolfking'), 1).board).toBe('wolfking');
  });

  it('gives the king the pack view and packmates his card', () => {
    let s = wkGame();
    s = apply(s, { type: 'GUARD_PASS', actor: 12 });
    // The king and one wolf vote; the kill need not resolve for the pack view.
    s = apply(s, { type: 'WOLF_KILL', actor: 4, target: 7 });
    s = apply(s, { type: 'WOLF_KILL', actor: 1, target: 7 });

    expect(viewFor(s, 4).you.wolfPack).toEqual([1, 2, 3, 4]);
    // A plain wolf sees the king's true role; good seats see nothing.
    expect(viewFor(s, 2).players.find((r) => r.seat === 4)?.role).toBe('white_wolf_king');
    expect(viewFor(s, 5).players.find((r) => r.seat === 4)?.role).toBeNull();
  });

  it('flags the guard window in the step and hands the guard his options', () => {
    const s = wkGame();
    const guardView = viewFor(s, 12);
    expect(guardView.step).toEqual({ kind: 'night', step: 'wolf', guardPending: true });
    expect(guardView.you.guardOptions).toEqual({
      maySelfProtect: true,
      mayPass: true,
      repeatBan: true,
      lastProtected: null,
    });
    // Options belong to the guard alone, and vanish once he acts.
    expect(viewFor(s, 5).you.guardOptions).toBeUndefined();
    const after = viewFor(apply(s, { type: 'GUARD_PROTECT', actor: 12, target: 9 }), 12);
    expect(after.you.guardOptions).toBeUndefined();
    expect(after.step).toEqual({ kind: 'night', step: 'wolf' });
  });

  it('keeps the night step clean on the classic board', () => {
    const s = apply(createGame(STANDARD), { type: 'START_GAME' });
    expect(viewFor(s, 1).step).toEqual({ kind: 'night', step: 'wolf' });
    expect(viewFor(s, 1).you.guardOptions).toBeUndefined();
  });
});

describe('viewFor — 白狼王 destruct state', () => {
  it('shows a spent ability to the king who used it mid-speech', () => {
    const s = apply(toSpeech(), { type: 'WOLF_KING_DESTRUCT', actor: 4, target: 9 });
    expect(viewFor(s, 4).you.destructUsed).toBe(true);
  });

  it('rides with a dead king through his settlement window, and only him', () => {
    const s = toKingSettlement();
    expect(s.phase).toBe('hunter-shot');
    expect(s.resolution?.queue[0]?.destructWindow).toBe(true);

    const kingView = viewFor(s, 4);
    expect(kingView.you.alive).toBe(false);
    expect(kingView.you.destructUsed).toBe(false);
    // Nobody else — spectator or dead villager — carries the destruct state.
    expect(viewFor(s, null).you.destructUsed).toBeUndefined();
    expect(viewFor(s, 7).you.destructUsed).toBeUndefined();
  });
});
