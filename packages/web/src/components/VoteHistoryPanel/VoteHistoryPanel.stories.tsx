import type { Meta, StoryObj } from '@storybook/react';

import { sampleVoteRounds } from '../../testing/fixtures';
import { VoteHistoryPanel } from './VoteHistoryPanel';

const meta = {
  title: 'Components/VoteHistoryPanel',
  component: VoteHistoryPanel,
} satisfies Meta<typeof VoteHistoryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyRounds: Story = {
  name: '尚无投票',
  args: { rounds: [] },
};

export const OneRound: Story = {
  name: '单轮：警长竞选',
  args: { rounds: sampleVoteRounds().slice(0, 1) },
};

export const MultiRounds: Story = {
  name: '多轮完整票形',
  args: { rounds: sampleVoteRounds() },
};

export const VoidTie: Story = {
  name: '平票流局',
  args: { rounds: sampleVoteRounds().slice(3) },
};

export const IdiotBlock: Story = {
  name: '白痴翻牌',
  args: { rounds: sampleVoteRounds().slice(1, 2) },
};
