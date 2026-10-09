import type { Meta, StoryObj } from '@storybook/react';

import { makeSeatView } from '../../testing/fixtures';
import { SeatChip } from './SeatChip';

const meta = {
  title: 'Components/SeatChip',
  component: SeatChip,
} satisfies Meta<typeof SeatChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Alive: Story = {
  name: '存活',
  args: { view: makeSeatView({ seat: 4 }) },
};

export const Self: Story = {
  name: '自己',
  args: { view: makeSeatView({ seat: 1, isSelf: true }) },
};

export const Sheriff: Story = {
  name: '警长',
  args: { view: makeSeatView({ seat: 3, isSheriff: true }) },
};

export const Speaking: Story = {
  name: '发言中',
  args: { view: makeSeatView({ seat: 7, isSpeaking: true }) },
};

export const Dead: Story = {
  name: '出局',
  args: { view: makeSeatView({ seat: 2, alive: false }) },
};

export const RevealedIdiot: Story = {
  name: '翻牌白痴',
  args: { view: makeSeatView({ seat: 5, revealedIdiot: true }) },
};

export const RoleRevealed: Story = {
  name: '公开身份',
  args: { view: makeSeatView({ seat: 9, role: 'hunter' }), showRole: true },
};

export const Disabled: Story = {
  name: '不可选',
  args: { view: makeSeatView({ seat: 6 }), disabled: true },
};
