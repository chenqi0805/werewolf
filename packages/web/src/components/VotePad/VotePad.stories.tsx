import type { Meta, StoryObj } from '@storybook/react';

import { makeSeatView, sampleTally } from '../../testing/fixtures';
import { VotePad } from './VotePad';

const meta = {
  title: 'Components/VotePad',
  component: VotePad,
} satisfies Meta<typeof VotePad>;

export default meta;
type Story = StoryObj<typeof meta>;

const candidates = [4, 7, 9, 11].map((seat) => makeSeatView({ seat }));

export const Choosing: Story = {
  name: '投票中',
  args: {
    mode: 'vote',
    candidates,
    canVote: true,
    onSubmitVote: () => undefined,
  },
};

export const SheriffVoting: Story = {
  name: '警长投票',
  args: {
    mode: 'vote',
    candidates,
    canVote: true,
    isSheriff: true,
    onSubmitVote: () => undefined,
  },
};

export const NoVoteRights: Story = {
  name: '无投票权',
  args: {
    mode: 'vote',
    candidates,
    canVote: false,
    voteBlockNote: '翻牌白痴没有投票权',
    onSubmitVote: () => undefined,
  },
};

export const TallyResult: Story = {
  name: '唱票出局',
  args: { mode: 'tally', tally: sampleTally() },
};

export const TallyVoid: Story = {
  name: '平票无人出局',
  args: {
    mode: 'tally',
    tally: {
      rows: [
        { target: 7, voterSeats: [1, 4], votes: 2.5 },
        { target: 11, voterSeats: [6, 9], votes: 2 },
      ],
      abstainers: [12],
      exiled: null,
      voided: true,
    },
  },
};
