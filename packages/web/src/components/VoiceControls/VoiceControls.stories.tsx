import type { Meta, StoryObj } from '@storybook/react';

import { VoiceControls } from './VoiceControls';

const meta = {
  title: 'Components/VoiceControls',
  component: VoiceControls,
} satisfies Meta<typeof VoiceControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {
  name: '正在播放',
  args: { muted: false, onToggle: () => undefined },
};

export const Muted: Story = {
  name: '已静音',
  args: { muted: true, onToggle: () => undefined },
};
