import { describe, expect, it } from 'vitest';
import type { PlayerView } from '@werewolf/server';

import { initialGameStore, reduceGame } from './gameStore';

const view = (overrides: Partial<PlayerView> = {}): PlayerView => ({
  phase: 'lobby',
  dayNumber: 0,
  winner: null,
  you: {
    seat: 3,
    role: null,
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 1,
  },
  players: [],
  step: { kind: 'lobby' },
  log: [],
  timer: null,
  ...overrides,
});

describe('reduceGame', () => {
  it('stores the latest view and clears the previous error', () => {
    const errored = reduceGame(initialGameStore, {
      kind: 'error',
      code: 'WRONG_PHASE',
      message: 'too early',
    });
    const next = reduceGame(errored, { kind: 'view', view: view({ phase: 'night' }) });
    expect(next.view?.phase).toBe('night');
    expect(next.lastError).toBeNull();
    expect(next.lastEvent).toBeNull();
  });

  it('keeps the last private event for toasts', () => {
    const event = { type: 'SEER_CHECKED', seat: 3, target: 5, isWolf: false } as never;
    const next = reduceGame(initialGameStore, { kind: 'event', event });
    expect(next.lastEvent).toBe(event);
    expect(next.view).toBeNull();
  });

  it('records the latest error without touching the view', () => {
    const withView = reduceGame(initialGameStore, { kind: 'view', view: view() });
    const next = reduceGame(withView, {
      kind: 'error',
      code: 'POTION_USED',
      message: '解药已用完',
    });
    expect(next.lastError).toEqual({ code: 'POTION_USED', message: '解药已用完' });
    expect(next.view).toBe(withView.view);
  });

  it('marks the session lost and reset returns to the initial store', () => {
    const lost = reduceGame(initialGameStore, { kind: 'session-lost', reason: 'BAD_TOKEN' });
    expect(lost.sessionLost).toBe('BAD_TOKEN');
    expect(reduceGame(lost, { kind: 'reset' })).toEqual(initialGameStore);
  });
});
