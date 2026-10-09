import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerAction, Seat } from '@werewolf/engine';
import { applyAction, createGame } from '@werewolf/engine';
import { eventsForSeat, viewFor, type PlayerView } from '../view';
import { ALL_SEATS, STANDARD } from './fixtures';

function apply(state: ReturnType<typeof createGame>, action: PlayerAction) {
  return applyAction(state, action).state;
}

/** Server-only event types: never visible to any seat. */
const SERVER_EVENT_TYPES = new Set([
  'WOLF_KILL_VOTE',
  'KILL_TARGET_SET',
  'WITCH_HEALED',
  'WITCH_POISONED',
  'WITCH_PASSED',
  'SEER_PASSED',
  'DEATH_RESOLVED',
  'SPEECH_ENDED',
]);

function expectNoServerEvents(view: PlayerView, where: string): void {
  const leaked = view.log.filter((e) => SERVER_EVENT_TYPES.has(e.type));
  expect(leaked, `${where}: server events leaked into a view log`).toEqual([]);
  // Seer results are private, not server-only: they may appear solely in the
  // seer's own view, and only for checks the seer itself made.
  for (const event of view.log) {
    if (event.type !== 'SEER_CHECKED') continue;
    expect(event.actor === view.you.seat, `${where}: SEER_CHECKED visible to a non-seer seat`).toBe(
      true,
    );
  }
}

function expectRoleExposure(
  view: PlayerView,
  viewer: Seat | null,
  revealed: Map<Seat, 'idiot' | 'hunter'>,
  over: boolean,
): void {
  const youRow = view.players.find((r) => r.seat === view.you.seat);
  const youRole = youRow ? youRow.role : null;
  for (const row of view.players) {
    if (row.role === null) continue;
    const allowed =
      row.seat === view.you.seat || // your own card
      over || // full reveal
      revealed.get(row.seat) === row.role || // publicly flipped card
      (youRole === 'werewolf' && row.role === 'werewolf'); // pack
    expect(allowed, `seat ${viewer ?? 'spectator'} saw seat ${row.seat} as ${row.role}`).toBe(true);
  }
}

describe('viewFor — lobby and wolves', () => {
  it('lobby views reveal no roles, not even to wolves', () => {
    const lobby = createGame(STANDARD);
    for (const seat of ALL_SEATS) {
      const view = viewFor(lobby, seat);
      expect(view.players.every((r) => r.role === null)).toBe(true);
      expect(view.you.role).toBeNull();
      expect(view.you.wolfPack).toBeUndefined();
      expect(view.phase).toBe('lobby');
    }
    expect(viewFor(lobby, null).players.every((r) => r.role === null)).toBe(true);
  });

  it('wolves see the pack and nobody else does', () => {
    let state = apply(createGame(STANDARD), { type: 'START_GAME' });
    // One wolf votes; the night is not resolved yet.
    state = apply(state, { type: 'WOLF_KILL', actor: 1, target: 5 });

    const wolfView = viewFor(state, 1);
    const packRoles = wolfView.players
      .filter((r) => [1, 2, 3, 4].includes(r.seat))
      .map((r) => r.role);
    expect(packRoles.every((role) => role === 'werewolf')).toBe(true);
    expect(wolfView.you.wolfPack).toEqual([1, 2, 3, 4]);
    // Wolves see no other hidden role (witch, seer, hunter, idiot).
    expect(wolfView.players.find((r) => r.seat === 9)?.role).toBeNull();
    expect(wolfView.players.find((r) => r.seat === 10)?.role).toBeNull();

    // Every non-wolf view: own role only.
    for (const seat of [5, 9, 10, 11, 12]) {
      const view = viewFor(state, seat);
      expect(view.you.wolfPack).toBeUndefined();
      expect(view.players.filter((r) => r.role !== null && r.seat !== seat)).toEqual([]);
    }
    // Spectators see nothing.
    const spec = viewFor(state, null);
    expect(spec.players.every((r) => r.role === null)).toBe(true);
  });
});

describe('viewFor — witch and seer privacies', () => {
  it('shows the kill target to the witch only while she decides', () => {
    let state = apply(createGame(STANDARD), { type: 'START_GAME' });
    for (const w of [1, 2, 3, 4]) {
      state = apply(state, { type: 'WOLF_KILL', actor: w, target: 5 });
    }
    // Witch step, potions both unused, night 1: self-save window open.
    const witchView = viewFor(state, 10);
    expect(witchView.you.witchPotions?.killTarget).toBe(5);
    expect(witchView.you.witchPotions?.maySelfSave).toBe(true);
    expect(witchView.step).toEqual({ kind: 'night', step: 'witch' });

    // No other view carries the kill target or potions.
    for (const seat of [1, 9, 11]) {
      const view = viewFor(state, seat);
      expect(view.you.witchPotions).toBeUndefined();
    }

    state = apply(state, { type: 'WITCH_PASS', actor: 10 });
    const afterPass = viewFor(state, 10);
    expect(afterPass.you.witchPotions?.killTarget).toBeUndefined();
  });

  it('keeps seer results private to the seer', () => {
    let state = apply(createGame(STANDARD), { type: 'START_GAME' });
    for (const w of [1, 2, 3, 4]) {
      state = apply(state, { type: 'WOLF_KILL', actor: w, target: 5 });
    }
    state = apply(state, { type: 'WITCH_PASS', actor: 10 });
    state = apply(state, { type: 'SEER_CHECK', actor: 9, target: 1 });

    const seerView = viewFor(state, 9);
    expect(seerView.you.seerChecks).toEqual({ 1: 'wolf' });
    const checked = seerView.log.find((e) => e.type === 'SEER_CHECKED');
    expect(checked).toBeDefined();

    for (const seat of [1, 10, 11]) {
      const view = viewFor(state, seat);
      expect(view.you.seerChecks).toBeUndefined();
      expect(view.log.some((e) => e.type === 'SEER_CHECKED')).toBe(false);
    }
  });
});

describe('viewFor — public reveals', () => {
  it('exposes a flipped idiot to everyone without leaking other roles', () => {
    let state = apply(createGame(STANDARD), { type: 'START_GAME' });
    for (const w of [1, 2, 3, 4]) {
      state = apply(state, { type: 'WOLF_KILL', actor: w, target: 5 });
    }
    state = apply(state, { type: 'WITCH_PASS', actor: 10 });
    state = apply(state, { type: 'SEER_CHECK', actor: 9, target: 1 });
    state = apply(state, { type: 'PROCEED' }); // empty signup -> no sheriff
    state = apply(state, { type: 'PROCEED' }); // announce seat 5
    state = apply(state, { type: 'PROCEED' }); // close last words
    for (let i = 0; i < 11; i++) {
      state = apply(state, { type: 'PROCEED' }); // speech slots
    }
    // Exile vote: everyone alive votes seat 12 (the idiot).
    for (const seat of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]) {
      state = apply(state, { type: 'EXILE_VOTE', actor: seat, target: 12 });
    }
    expect(state.phase).toBe('night'); // reveal resolved, next night begins

    const revealed = new Map<Seat, 'idiot' | 'hunter'>([[12, 'idiot']]);
    for (const seat of ALL_SEATS) {
      const view = viewFor(state, seat);
      expectRoleExposure(view, seat, revealed, false);
      expectNoServerEvents(view, `seat ${seat}`);
      expect(view.players.find((r) => r.seat === 12)?.role).toBe('idiot');
      expect(view.players.find((r) => r.seat === 12)?.revealedIdiot).toBe(true);
      expect(view.players.find((r) => r.seat === 12)?.voteWeight).toBe(0);
      // No other role leaked — except the pack, which wolves legitimately see.
      const isWolfViewer = view.players.find((r) => r.seat === seat)?.role === 'werewolf';
      expect(
        view.players.filter(
          (r) =>
            r.seat !== 12 &&
            r.seat !== seat &&
            r.role !== null &&
            !(isWolfViewer && r.role === 'werewolf'),
        ),
      ).toEqual([]);
    }
    const spectator = viewFor(state, null);
    expectRoleExposure(spectator, null, revealed, false);
  });
});

describe('eventsForSeat', () => {
  it('routes private events to their seat and hides server events', () => {
    let state = apply(createGame(STANDARD), { type: 'START_GAME' });
    for (const w of [1, 2, 3, 4]) {
      state = apply(state, { type: 'WOLF_KILL', actor: w, target: 5 });
    }
    state = apply(state, { type: 'WITCH_PASS', actor: 10 });
    state = apply(state, { type: 'SEER_CHECK', actor: 9, target: 1 });

    const events: GameEvent[] = state.log;
    for (const seat of ALL_SEATS) {
      const visible = eventsForSeat(events, seat);
      expect(visible.every((e) => !SERVER_EVENT_TYPES.has(e.type))).toBe(true);
      expect(visible.some((e) => e.type === 'SEER_CHECKED')).toBe(seat === 9);
    }
    // The seer alone sees his check result.
    expect(eventsForSeat(events, 9).some((e) => e.type === 'SEER_CHECKED')).toBe(true);
  });
});
