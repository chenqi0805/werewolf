import type { Meta, StoryObj } from '@storybook/react';

import { RoleCard } from './RoleCard';

const meta = {
  title: 'Components/RoleCard',
  component: RoleCard,
} satisfies Meta<typeof RoleCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FaceDown: Story = {
  name: '未翻开',
  args: { role: 'villager', seat: 7, faceDown: true },
};

export const Werewolf: Story = {
  name: '狼人',
  args: { role: 'werewolf', seat: 3, name: '阿夜' },
};

export const Villager: Story = {
  name: '村民',
  args: { role: 'villager', seat: 8 },
};

export const Seer: Story = {
  name: '预言家',
  args: { role: 'seer', seat: 5, name: '阿昼' },
};

export const Witch: Story = {
  name: '女巫',
  args: { role: 'witch', seat: 6 },
};

export const Hunter: Story = {
  name: '猎人',
  args: { role: 'hunter', seat: 9 },
};

export const Idiot: Story = {
  name: '白痴',
  args: { role: 'idiot', seat: 12 },
};
