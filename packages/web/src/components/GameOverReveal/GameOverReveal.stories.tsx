import type { Meta, StoryObj } from '@storybook/react';

import type { PlayerReveal } from '../../types';
import { GameOverReveal } from './GameOverReveal';

const meta = {
  title: 'Components/GameOverReveal',
  component: GameOverReveal,
} satisfies Meta<typeof GameOverReveal>;

export default meta;
type Story = StoryObj<typeof meta>;

const reveals: PlayerReveal[] = [
  { seat: 1, role: 'werewolf', alive: true, hasBadge: true },
  { seat: 2, role: 'seer', alive: false, hasBadge: false },
  { seat: 3, role: 'werewolf', alive: true, hasBadge: false },
  { seat: 4, role: 'villager', alive: false, hasBadge: false },
  { seat: 5, role: 'idiot', alive: true, hasBadge: false },
  { seat: 6, role: 'witch', alive: false, hasBadge: false },
];

export const WolfWin: Story = {
  name: '狼人屠边',
  args: { winner: 'wolves', reveals, dayNumber: 3, onBackToLobby: () => undefined },
};

export const GoodWin: Story = {
  name: '好人胜利',
  args: { winner: 'good', reveals, dayNumber: 2, onBackToLobby: () => undefined },
};
