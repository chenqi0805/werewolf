import type { Meta, StoryObj } from '@storybook/react';

import { makeSeatView } from '../../testing/fixtures';
import type { SeerResult } from '../../types';
import { SeerPad } from './SeerPad';

const meta = {
  title: 'Components/SeerPad',
  component: SeerPad,
} satisfies Meta<typeof SeerPad>;

export default meta;
type Story = StoryObj<typeof meta>;

const targets = [4, 7, 9, 11].map((seat) => makeSeatView({ seat }));

export const FirstNight: Story = {
  name: '首夜无记录',
  args: {
    results: [],
    targets,
    onCheck: () => undefined,
  },
};

export const WithHistory: Story = {
  name: '有查验记录',
  args: {
    results: [
      { seat: 7, isWolf: true },
      { seat: 4, isWolf: false },
      { seat: 9, isWolf: false },
    ] satisfies SeerResult[],
    targets,
    onCheck: () => undefined,
  },
};

export const Locked: Story = {
  name: '未轮到行动',
  args: {
    results: [{ seat: 7, isWolf: true }],
    targets,
    onCheck: () => undefined,
    disabled: true,
  },
};
