import type { Meta, StoryObj } from '@storybook/react';

import { livingTargets } from '../../testing/fixtures';
import { SeatPicker } from './SeatPicker';

const meta = {
  title: 'Components/SeatPicker',
  component: SeatPicker,
} satisfies Meta<typeof SeatPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {
  name: '未选择',
  args: { options: livingTargets(), onSelect: () => undefined },
};

export const Selected: Story = {
  name: '已选择',
  args: { options: livingTargets(), onSelect: () => undefined, selected: 6 },
};

export const DisabledPicker: Story = {
  name: '锁定',
  args: { options: livingTargets(), onSelect: () => undefined, disabled: true },
};

export const NoOptions: Story = {
  name: '无可选目标',
  args: { options: [], onSelect: () => undefined },
};
