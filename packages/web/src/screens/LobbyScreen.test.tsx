// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerView } from '@werewolf/server';
import type { GameSocket } from '../client/socketClient';

import { LobbyScreen } from './LobbyScreen';

// React 19's act() requires the act-environment flag outside its own runner.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (seat: number | null): PlayerView => ({
  phase: 'lobby',
  dayNumber: 0,
  winner: null,
  board: 'classic',
  you: {
    seat,
    role: null,
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: seat === null ? 0 : 1,
  },
  players: [],
  step: { kind: 'lobby' },
  log: [],
  timer: null,
});

interface Emits {
  socket: GameSocket;
  events: string[];
  /** Ack the given event's callback with `body` (default `{ ok: true }`). */
  ackWith(event: string, body: unknown): void;
}

/** Socket double that records emits and answers the events wired with acks. */
function fakeSocket(): Emits {
  const events: string[] = [];
  const acks = new Map<string, unknown>();
  const emit = (event: string, ...args: unknown[]): unknown => {
    events.push(event);
    const ack = args.at(-1);
    // The timeout-decorated ack contract: (err = null, resp) on a server answer.
    if (typeof ack === 'function' && acks.has(event)) ack(null, acks.get(event));
    return undefined;
  };
  const socket = {
    // The wrappers arm a timeout budget before emitting.
    timeout: (): { emit: typeof emit } => ({ emit }),
    emit,
  } as unknown as GameSocket;
  return {
    socket,
    events,
    ackWith(event, body) {
      acks.set(event, body);
    },
  };
}

/** Render one LobbyScreen and return the quit button. */
async function renderLobby(socket: GameSocket, seat: number | null, onQuit: () => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <LobbyScreen view={view(seat)} roomCode="ABC123" socket={socket} onQuit={onQuit} />,
    ),
  );
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === '退出房间',
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error('退出房间 button not rendered');
  return { root, container, button };
}

describe('LobbyScreen handleQuit', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('seated player: leaves the room first, then quits to the main page', async () => {
    const onQuit = vi.fn();
    const fake = fakeSocket();
    fake.ackWith('room:leave', { ok: true });
    const { root, container, button } = await renderLobby(fake.socket, 3, onQuit);

    await act(async () =>
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    await act(async () => undefined); // flush the awaited leaveRoom → onQuit chain
    expect(fake.events).toEqual(['room:leave']);
    expect(onQuit).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    container.remove();
  });

  it('seat-less viewer: quits straight to the main page, never emits room:leave', async () => {
    const onQuit = vi.fn();
    const fake = fakeSocket();
    const { root, container, button } = await renderLobby(fake.socket, null, onQuit);

    await act(async () =>
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    await act(async () => undefined);
    expect(fake.events).toEqual([]);
    expect(onQuit).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    container.remove();
  });

  it('seated player: a failed leave keeps the viewer in the lobby with the error', async () => {
    const onQuit = vi.fn();
    const fake = fakeSocket();
    fake.ackWith('room:leave', { error: 'NOT_IN_ROOM' });
    const { root, container, button } = await renderLobby(fake.socket, 3, onQuit);

    await act(async () =>
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    await act(async () => undefined);
    expect(onQuit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('你已不在房间中');

    await act(async () => root.unmount());
    container.remove();
  });
});
