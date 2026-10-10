import type { Meta, StoryObj } from '@storybook/react';

import { makeSeatView } from '../../testing/fixtures';
import { GuardPad } from './GuardPad';

const meta = {
  title: 'Components/GuardPad',
  component: GuardPad,
} satisfies Meta<typeof GuardPad>;

export default meta;
type Story = StoryObj<typeof meta>;

const targets = [4, 7, 9, 11].map((seat) => makeSeatView({ seat }));

export const FirstNight: Story = {
  name: '首夜可选自守',
  args: {
    self: 12,
    options: { maySelfProtect: true, mayPass: true, repeatBan: true, lastProtected: null },
    targets,
    onProtect: () => undefined,
    onPass: () => undefined,
  },
};

export const RepeatBan: Story = {
  name: '连守禁选上夜目标',
  args: {
    self: 12,
    options: { maySelfProtect: true, mayPass: true, repeatBan: true, lastProtected: 7 },
    targets,
    onProtect: () => undefined,
    onPass: () => undefined,
  },
};

export const NoSelfProtect: Story = {
  name: '本板不可自守',
  args: {
    self: 12,
    options: { maySelfProtect: false, mayPass: true, repeatBan: false, lastProtected: null },
    targets,
    onProtect: () => undefined,
    onPass: () => undefined,
  },
};

export const Locked: Story = {
  name: '未轮到行动',
  args: {
    self: 12,
    options: { maySelfProtect: true, mayPass: true, repeatBan: true, lastProtected: 7 },
    targets,
    onProtect: () => undefined,
    onPass: () => undefined,
    disabled: true,
  },
};
