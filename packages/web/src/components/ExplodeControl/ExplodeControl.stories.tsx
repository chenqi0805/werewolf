import type { Meta, StoryObj } from '@storybook/react';

import { ExplodeControl } from './ExplodeControl';

const meta = {
  title: 'Components/ExplodeControl',
  component: ExplodeControl,
} satisfies Meta<typeof ExplodeControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Armed: Story = {
  name: '待发自爆',
  args: {
    onExplode: () => undefined,
  },
};

export const Confirming: Story = {
  name: '确认自爆',
  args: {
    onExplode: () => undefined,
  },
  parameters: { docs: { description: { story: '点击「自爆」后进入不可逆的确认流程。' } } },
};

export const Locked: Story = {
  name: '未轮到行动',
  args: {
    onExplode: () => undefined,
    disabled: true,
  },
};
