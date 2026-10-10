// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerView } from '@werewolf/server';

import { GameOverScreen } from './GameOverScreen';

// React 19's act() requires the act-environment flag outside its own runner.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The smallest view that renders the whole screen: winner + two revealed rows.
const view: PlayerView = {
  phase: 'game-over',
  dayNumber: 3,
  winner: 'wolves',
  board: 'classic',
  you: {
    seat: 3,
    role: 'villager',
    alive: false,
    hasBadge: false,
    revealedIdiot: false,
    voteWeight: 1,
  },
  players: [
    {
      seat: 1,
      name: '',
      alive: true,
      hasBadge: true,
      revealedIdiot: false,
      voteWeight: 1.5,
      occupied: true,
      isBot: false,
      botName: null,
      role: 'werewolf',
    },
    {
      seat: 3,
      name: '',
      alive: false,
      hasBadge: false,
      revealedIdiot: false,
      voteWeight: 1,
      occupied: true,
      isBot: false,
      botName: null,
      role: 'villager',
    },
  ],
  step: { kind: 'game-over' },
  log: [],
  timer: null,
};

describe('GameOverScreen', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the 返回主页 exit control when onExit is given', () => {
    const markup = renderToStaticMarkup(<GameOverScreen view={view} onExit={() => undefined} />);
    expect(markup).toContain('返回主页');
  });

  it('stays free of the exit control when onExit is absent (stories, compositions)', () => {
    const markup = renderToStaticMarkup(<GameOverScreen view={view} />);
    expect(markup).not.toContain('返回主页');
  });

  it('routes the exit click to onExit — client-side only, no socket traffic', async () => {
    const onExit = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<GameOverScreen view={view} onExit={onExit} />));

    const button = container.querySelector('button.scr-exit');
    expect(button?.textContent).toBe('返回主页');
    await act(async () =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    expect(onExit).toHaveBeenCalledOnce();
  });
});
