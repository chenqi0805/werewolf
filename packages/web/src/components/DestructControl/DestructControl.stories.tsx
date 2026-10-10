import type { Meta, StoryObj } from '@storybook/react';

import { makeSeatView } from '../../testing/fixtures';
import { DestructControl } from './DestructControl';

const meta = {
  title: 'Components/DestructControl',
  component: DestructControl,
} satisfies Meta<typeof DestructControl>;

export default meta;
type Story = StoryObj<typeof meta>;

const targets = [4, 7, 9, 11].map((seat) => makeSeatView({ seat }));

export const Armed: Story = {
  name: '待发自爆',
  args: {
    targets,
    onDestruct: () => undefined,
  },
};

export const Choosing: Story = {
  name: '选择目标',
  args: {
    targets,
    onDestruct: () => undefined,
  },
  parameters: { docs: { description: { story: '点击「自爆」后进入选人与确认流程。' } } },
};

export const NoTargets: Story = {
  name: '无可带走目标',
  args: {
    targets: [],
    onDestruct: () => undefined,
  },
};

export const Locked: Story = {
  name: '未轮到行动',
  args: {
    targets,
    onDestruct: () => undefined,
    disabled: true,
  },
};
