// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerView } from '@werewolf/server';
import type { GameSocket } from '../client/socketClient';

import { GameScreen } from './GameScreen';

// The screen hardwires the real voice player (its default clock constructs an
// AudioContext); the spectator test stubs that seam out — no Web Audio here.
vi.mock('../client/voicePlayer', () => ({
  createVoicePlayer: () => ({ muted: () => false, setMuted: () => {}, dispose: () => {} }),
}));

// React 19's act() requires the act-environment flag outside its own runner.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A mid-game spectator: no seat, watching the wolf step. This shape only
// exists through a finished-room join today — the branch is the client's
// contract for any seat-less viewer holding a live view.
const spectatorView: PlayerView = {
  phase: 'night',
  dayNumber: 2,
  winner: null,
  board: 'classic',
  you: {
    seat: null,
    role: null,
    alive: true,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 0,
  },
  players: [
    {
      seat: 1,
      name: '',
      alive: true,
      hasBadge: false,
      revealedIdiot: false,
      voteWeight: 1,
      occupied: true,
      isBot: false,
      botName: null,
      role: null,
    },
  ],
  step: { kind: 'night', step: 'wolf' },
  log: [],
  timer: null,
};

/** Record-and-ack socket double: createVoicePlayer subscribes on `on`. */
function fakeSocket(): GameSocket {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as GameSocket;
}

describe('GameScreen spectator branch', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('offers 返回主页 and exits without touching the socket or the action send', async () => {
    const onExit = vi.fn();
    const socket = fakeSocket();
    const send = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <GameScreen
          view={spectatorView}
          roomCode="ABC123"
          send={send}
          socket={socket}
          onExit={onExit}
        />,
      ),
    );

    const button = container.querySelector('button.scr-exit');
    expect(button?.textContent).toBe('返回主页');
    expect(send).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();

    await act(async () =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    expect(onExit).toHaveBeenCalledOnce();
    // The whole point: a seat-less viewer never emits room:leave.
    expect(socket.emit).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
