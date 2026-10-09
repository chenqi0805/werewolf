import type { Meta, StoryObj } from '@storybook/react';

import type { PostgameReply } from '@werewolf/server';

import { AckError } from '../../client/socketClient';
import { samplePostgameReply, samplePostgameStats } from '../../testing/fixtures';
import { PostgameReview } from './PostgameReview';

const meta = {
  title: 'Components/PostgameReview',
  component: PostgameReview,
} satisfies Meta<typeof PostgameReview>;

export default meta;
type Story = StoryObj<typeof meta>;

const stats = samplePostgameStats();

/** Stub that never settles — the section stays in its loading state. */
const never = (): Promise<PostgameReply> => new Promise(() => undefined);

/** Stub that resolves after a beat — click 生成复盘 and watch the full flow. */
const soon = (): Promise<PostgameReply> =>
  new Promise((resolve) => setTimeout(() => resolve(samplePostgameReply()), 600));

const unavailable = (): Promise<PostgameReply> =>
  Promise.reject(new AckError('ASSISTANT_UNAVAILABLE'));

const failed = (): Promise<PostgameReply> => Promise.reject(new AckError('POSTGAME_ERROR'));

export const Idle: Story = {
  name: '等待生成',
  args: { stats, winner: 'good', onAnalyze: soon },
};

export const Loading: Story = {
  name: '复盘中',
  args: { stats, winner: 'good', onAnalyze: never },
};

export const Review: Story = {
  name: '复盘就绪',
  args: { stats, winner: 'good', onAnalyze: soon },
};

export const Unconfigured: Story = {
  name: '助手未配置',
  args: { stats, winner: 'wolves', onAnalyze: unavailable },
};

export const Failed: Story = {
  name: '生成失败',
  args: { stats, winner: 'good', onAnalyze: failed },
};

export const Disabled: Story = {
  name: '禁用',
  args: { stats, winner: 'good', onAnalyze: soon, disabled: true },
};
