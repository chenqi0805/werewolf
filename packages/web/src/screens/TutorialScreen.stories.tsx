import type { Meta, StoryObj } from '@storybook/react';

import { TutorialScreen } from './TutorialScreen';

const meta = {
  title: 'Screens/TutorialScreen',
  component: TutorialScreen,
} satisfies Meta<typeof TutorialScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Page: Story = {
  name: '大厅页面',
  args: { onClose: () => {} },
};

export const InGameModal: Story = {
  name: '游戏内弹层',
  args: { onClose: () => {}, modal: true },
};
