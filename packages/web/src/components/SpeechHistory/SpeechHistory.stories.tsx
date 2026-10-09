import type { Meta, StoryObj } from '@storybook/react';

import { sampleSpeechGroups } from '../../testing/fixtures';
import { SpeechHistory } from './SpeechHistory';

const meta = {
  title: 'Components/SpeechHistory',
  component: SpeechHistory,
} satisfies Meta<typeof SpeechHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyHistory: Story = {
  name: '尚无发言',
  args: { groups: [] },
};

export const TwoDays: Story = {
  name: '两天发言记录',
  args: { groups: sampleSpeechGroups() },
};
