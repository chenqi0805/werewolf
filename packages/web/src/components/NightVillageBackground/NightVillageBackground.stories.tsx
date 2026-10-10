import type { Meta, StoryObj } from '@storybook/react';

import { fullBoard } from '../../testing/fixtures';
import { SeatGrid } from '../SeatGrid/SeatGrid';
import { NightVillageBackground } from './NightVillageBackground';
import '../../screens/screens.css';

const meta = {
  title: 'Components/NightVillageBackground',
  component: NightVillageBackground,
} satisfies Meta<typeof NightVillageBackground>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The layer as the game screen mounts it: village page class + panels above. */
export const GameBoardLayer: Story = {
  name: '游戏桌底图',
  render: () => (
    <main className="scr-page scr-page--village">
      <NightVillageBackground />
      <section className="scr-panel">
        <div className="scr-row scr-row--spread">
          <h1 className="scr-title">第 2 天 · 白天</h1>
          <span className="scr-caption">你的座位 3 号 · 村民</span>
        </div>
        <SeatGrid seats={fullBoard()} />
        <p className="scr-caption">2号：昨晚是平安夜，女巫一定救了人……</p>
      </section>
    </main>
  ),
};
