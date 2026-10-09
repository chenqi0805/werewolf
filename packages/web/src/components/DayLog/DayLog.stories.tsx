import type { Meta, StoryObj } from '@storybook/react';

import type { LogEntry } from '../../types';
import { DayLog } from './DayLog';

const meta = {
  title: 'Components/DayLog',
  component: DayLog,
} satisfies Meta<typeof DayLog>;

export default meta;
type Story = StoryObj<typeof meta>;

const entries: LogEntry[] = [
  { id: 'log-1', day: 1, kind: 'system', text: '天黑请闭眼' },
  { id: 'log-2', day: 1, kind: 'death', text: '昨晚 2号玩家倒牌' },
  { id: 'log-3', day: 1, kind: 'sheriff', text: '1号当选警长' },
  { id: 'log-4', day: 1, kind: 'vote', text: '3号被放逐出局' },
  { id: 'log-5', day: 2, kind: 'system', text: '天黑请闭眼' },
  { id: 'log-6', day: 2, kind: 'death', text: '今晨无人倒牌，平安夜' },
  { id: 'log-7', day: 2, kind: 'reveal', text: '5号翻开身份牌：白痴' },
];

export const EmptyLog: Story = {
  name: '尚未开始',
  args: { entries: [] },
};

export const TwoDays: Story = {
  name: '两天记录',
  args: { entries },
};
