import type { Meta, StoryObj } from '@storybook/react';

import { livingTargets } from '../../testing/fixtures';
import { WolfPad } from './WolfPad';

const meta = {
  title: 'Components/WolfPad',
  component: WolfPad,
} satisfies Meta<typeof WolfPad>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Deciding: Story = {
  name: '商议中',
  args: {
    wolves: [3, 7, 11],
    targets: livingTargets(),
    onConfirm: () => undefined,
  },
};

export const PackAligned: Story = {
  name: '狼队有意向',
  args: {
    wolves: [3, 7, 11],
    targets: livingTargets(),
    packTarget: 6,
    onConfirm: () => undefined,
  },
};

export const Locked: Story = {
  name: '未轮到行动',
  args: {
    wolves: [3, 7, 11],
    targets: livingTargets(),
    onConfirm: () => undefined,
    disabled: true,
    disabledNote: '等待其他狼人确认行动',
  },
};
