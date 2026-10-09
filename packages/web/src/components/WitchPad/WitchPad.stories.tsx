import type { Meta, StoryObj } from '@storybook/react';

import { makeSeatView } from '../../testing/fixtures';
import { WitchPad } from './WitchPad';

const meta = {
  title: 'Components/WitchPad',
  component: WitchPad,
} satisfies Meta<typeof WitchPad>;

export default meta;
type Story = StoryObj<typeof meta>;

const targets = [3, 4, 7, 9].map((seat) => makeSeatView({ seat }));

export const CanSave: Story = {
  name: '可救可用毒',
  args: {
    self: 6,
    killTarget: 4,
    healUsed: false,
    poisonUsed: false,
    maySelfSave: false,
    targets,
    onHeal: () => undefined,
    onPoison: () => undefined,
    onSkip: () => undefined,
  },
};

export const NoVictim: Story = {
  name: '空刀之夜',
  args: {
    self: 6,
    killTarget: null,
    healUsed: false,
    poisonUsed: false,
    maySelfSave: false,
    targets,
    onHeal: () => undefined,
    onPoison: () => undefined,
    onSkip: () => undefined,
  },
};

export const PotionsSpent: Story = {
  name: '药剂用尽',
  args: {
    self: 6,
    killTarget: 9,
    healUsed: true,
    poisonUsed: true,
    maySelfSave: false,
    targets,
    onHeal: () => undefined,
    onPoison: () => undefined,
    onSkip: () => undefined,
  },
};

export const SelfSaveBlocked: Story = {
  name: '非首夜被刀不能自救',
  args: {
    self: 6,
    killTarget: 6,
    healUsed: false,
    poisonUsed: false,
    maySelfSave: false,
    targets,
    onHeal: () => undefined,
    onPoison: () => undefined,
    onSkip: () => undefined,
  },
};

export const SelfSaveAllowed: Story = {
  name: '首夜被刀可自救',
  args: {
    self: 6,
    killTarget: 6,
    healUsed: false,
    poisonUsed: false,
    maySelfSave: true,
    targets,
    onHeal: () => undefined,
    onPoison: () => undefined,
    onSkip: () => undefined,
  },
};
