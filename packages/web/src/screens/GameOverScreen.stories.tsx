import type { Meta, StoryObj } from '@storybook/react';
import type { PlayerView } from '@werewolf/server';

import { GameOverScreen } from './GameOverScreen';

const meta = {
  title: 'Screens/GameOverScreen',
  component: GameOverScreen,
} satisfies Meta<typeof GameOverScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The smallest finished game: winner set, every role revealed. */
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

export const WithExit: Story = {
  name: '返回主页',
  args: { view, socket: null, onExit: () => undefined },
};

export const WithoutExit: Story = {
  name: '无出口（故事页）',
  args: { view, socket: null },
};
