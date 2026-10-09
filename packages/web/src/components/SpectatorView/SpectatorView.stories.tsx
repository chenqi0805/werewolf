import type { Meta, StoryObj } from '@storybook/react';

import { fullBoard, nextMessageId } from '../../testing/fixtures';
import type { SpeechMessage } from '../../types';
import { SpectatorView } from './SpectatorView';

const meta = {
  title: 'Components/SpectatorView',
  component: SpectatorView,
} satisfies Meta<typeof SpectatorView>;

export default meta;
type Story = StoryObj<typeof meta>;

const messages: SpeechMessage[] = [
  { id: nextMessageId(), seat: 7, name: '起跳预言家', text: '我是预言家，昨晚查验 9号，金水。' },
  { id: nextMessageId(), seat: 11, name: '悍跳狼', text: '他不是预言家，我才是。' },
];

export const Default: Story = {
  name: '观战中',
  args: {
    seats: fullBoard(),
    speakingSeat: 7,
    messages,
    dayNumber: 2,
    phaseCaption: '发言中',
  },
};
