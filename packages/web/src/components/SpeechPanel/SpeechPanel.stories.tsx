import type { Meta, StoryObj } from '@storybook/react';

import { nextMessageId } from '../../testing/fixtures';
import type { SpeechMessage } from '../../types';
import { SpeechPanel } from './SpeechPanel';

const meta = {
  title: 'Components/SpeechPanel',
  component: SpeechPanel,
} satisfies Meta<typeof SpeechPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const messages: SpeechMessage[] = [
  { id: nextMessageId(), seat: 7, name: '起跳预言家', text: '我是预言家，昨晚查验 9号，金水。' },
  {
    id: nextMessageId(),
    seat: 11,
    name: '悍跳狼',
    text: '他不是预言家，我才是，昨晚查验 3号查杀。',
  },
  {
    id: nextMessageId(),
    seat: 3,
    name: '查杀发言',
    text: '我不是狼，11号明显在悍跳，大家看清发言。',
  },
];

export const Empty: Story = {
  name: '还没有发言',
  args: { messages: [], speakingSeat: 7, mySeat: 4, canSpeak: false, onSend: () => undefined },
};

export const MyTurn: Story = {
  name: '轮到我发言',
  args: { messages, speakingSeat: 4, mySeat: 4, canSpeak: true, onSend: () => undefined },
};

export const OthersSpeaking: Story = {
  name: '他人发言中',
  args: { messages, speakingSeat: 7, mySeat: 4, canSpeak: false, onSend: () => undefined },
};

export const Spectator: Story = {
  name: '观战视角',
  args: {
    messages,
    speakingSeat: 7,
    mySeat: null,
    canSpeak: false,
    onSend: () => undefined,
    disabled: true,
    hint: '观战视角，无法发言',
  },
};
