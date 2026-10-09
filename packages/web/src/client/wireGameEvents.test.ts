import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/engine';
import type { PlayerView } from '@werewolf/server';

import type { GameStoreMessage } from './gameStore';
import type { GameSocket } from './socketClient';
import { wireGameEvents } from './wireGameEvents';

/** Socket stand-in capturing on/off registrations. */
function fakeSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    off: (event: string, fn: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((f) => f !== fn),
      );
    },
    fire: (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  } as unknown as GameSocket & { fire: (event: string, ...args: unknown[]) => void };
}

describe('wireGameEvents', () => {
  it('routes view, event, and error payloads into dispatch messages', () => {
    const socket = fakeSocket();
    const seen: GameStoreMessage[] = [];
    wireGameEvents(socket, { onMessage: (m) => seen.push(m) });

    const view = { phase: 'night' } as PlayerView;
    const event = { type: 'DAWN_ANNOUNCED', day: 1, deaths: [] } as unknown as GameEvent;
    socket.fire('game:view', view);
    socket.fire('game:event', event);
    socket.fire('game:error', { code: 'WRONG_PHASE', message: 'not your turn' });

    expect(seen).toEqual([
      { kind: 'view', view },
      { kind: 'event', event },
      { kind: 'error', code: 'WRONG_PHASE', message: 'not your turn' },
    ]);
  });

  it('unsubscribes everything on dispose', () => {
    const socket = fakeSocket();
    const seen: GameStoreMessage[] = [];
    const dispose = wireGameEvents(socket, { onMessage: (m) => seen.push(m) });
    dispose();
    socket.fire('game:view', { phase: 'lobby' } as PlayerView);
    socket.fire('game:event', {} as GameEvent);
    socket.fire('game:error', { code: 'X', message: 'y' });
    expect(seen).toEqual([]);
  });
});
