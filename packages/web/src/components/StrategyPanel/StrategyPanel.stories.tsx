import type { Meta, StoryObj } from '@storybook/react';

import type { StrategyReply } from '@werewolf/server';

import { AckError } from '../../client/socketClient';
import { sampleSpeechGroups } from '../../testing/fixtures';
import { StrategyPanel } from './StrategyPanel';

const meta = {
  title: 'Components/StrategyPanel',
  component: StrategyPanel,
} satisfies Meta<typeof StrategyPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const reply: StrategyReply = {
  lines: [
    '我是金水身份，今天先把我掌握的票型讲清楚。',
    '3号的发言全是套话，我建议大家盯住他的票流。',
    '如果11号继续悍跳，我这里直接对跳到底。',
  ],
  reasoning: '你是好人阵营的预言家，信息位在你手里；先报查验建立信任，再引导票型压制悍跳狼。',
  warnings: ['报出查验后，狼队今晚大概率精确刀你。', '措辞不要过于绝对，留出被反水的余地。'],
};

/** Stub that never settles — the panel stays in its loading state. */
const never = (): Promise<StrategyReply> => new Promise(() => undefined);

/** Stub that resolves after a beat — click 请求建议 and watch the full flow. */
const soon = (): Promise<StrategyReply> =>
  new Promise((resolve) => setTimeout(() => resolve(reply), 600));

const unavailable = (): Promise<StrategyReply> =>
  Promise.reject(new AckError('ASSISTANT_UNAVAILABLE'));

const rateLimited = (): Promise<StrategyReply> => Promise.reject(new AckError('RATE_LIMITED'));

export const Idle: Story = {
  name: '等待请求',
  args: { role: 'seer', dayRecords: sampleSpeechGroups(), onSuggest: soon },
};

export const Loading: Story = {
  name: '思考中',
  args: { role: 'seer', dayRecords: sampleSpeechGroups(), onSuggest: never },
};

export const Suggestions: Story = {
  name: '给出建议',
  args: { role: 'seer', dayRecords: sampleSpeechGroups(), onSuggest: soon },
};

export const Unconfigured: Story = {
  name: '助手未配置',
  args: { role: 'werewolf', dayRecords: sampleSpeechGroups(), onSuggest: unavailable },
};

export const Failed: Story = {
  name: '请求失败',
  args: { role: 'witch', dayRecords: sampleSpeechGroups(), onSuggest: rateLimited },
};

export const Disabled: Story = {
  name: '禁用',
  args: { role: 'villager', dayRecords: sampleSpeechGroups(), onSuggest: soon, disabled: true },
};
