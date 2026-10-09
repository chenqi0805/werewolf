import type { Meta, StoryObj } from '@storybook/react';

import { fullBoard } from '../../testing/fixtures';
import { SeatGrid } from './SeatGrid';

const meta = {
  title: 'Components/SeatGrid',
  component: SeatGrid,
} satisfies Meta<typeof SeatGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartiallyJoined: Story = {
  name: '部分入座',
  args: { seats: fullBoard().slice(0, 7) },
};

export const FullBoardView: Story = {
  name: '满员座位表',
  args: { seats: fullBoard() },
};

export const TargetSelection: Story = {
  name: '选目标',
  args: { seats: fullBoard(), onSelect: () => undefined, selected: 6 },
};

export const Locked: Story = {
  name: '未轮到行动',
  args: { seats: fullBoard(), onSelect: () => undefined, disabled: true },
};

export const RolesRevealed: Story = {
  name: '公开身份',
  args: {
    seats: fullBoard().map((view, index) =>
      index % 3 === 0 ? { ...view, role: view.seat === 5 ? 'idiot' : 'werewolf' } : view,
    ),
    showRoles: true,
  },
};
