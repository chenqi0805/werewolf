import { useState } from 'react';
import type { JSX } from 'react';
import type { PlayerView } from '@werewolf/server';

import { seatViewsOf } from '../client/adapters';
import { SeatGrid } from '../components';
import type { SeatView } from '../types';
import { startGame, type GameSocket } from '../client/socketClient';
import { TutorialScreen } from './TutorialScreen';

interface LobbyScreenProps {
  view: PlayerView;
  roomCode: string;
  socket: GameSocket;
}

/**
 * Pre-game waiting room: share the code, watch seats fill, start when ready.
 * The server rejects a start it does not allow; the code surfaces inline.
 */
export function LobbyScreen({ view, roomCode, socket }: LobbyScreenProps): JSX.Element {
  const seats: SeatView[] = seatViewsOf(view);
  const joined = seats.filter((s) => s.alive).length;
  const [startError, setStartError] = useState<string | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);

  async function handleStart(): Promise<void> {
    setStartError(null);
    try {
      await startGame(socket);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : '开局失败，请重试');
    }
  }

  if (showTutorial) {
    return <TutorialScreen onClose={() => setShowTutorial(false)} />;
  }

  return (
    <main className="scr-page">
      <section className="scr-panel">
        <div className="scr-row scr-row--spread">
          <h1 className="scr-title">等待玩家</h1>
          <div className="scr-row">
            <button type="button" onClick={() => setShowTutorial(true)}>
              玩法教程
            </button>
            <span className="scr-caption">{joined}/12 人已入座</span>
          </div>
        </div>
        <div className="scr-row">
          <span className="scr-caption">房间号</span>
          <span className="scr-code">{roomCode}</span>
        </div>
        <p className="scr-subtitle">把房间号发给朋友，人满后任意玩家可以开局。</p>
        <SeatGrid seats={seats} />
        <div className="scr-actions">
          <button type="button" onClick={handleStart} disabled={joined < 5}>
            {joined < 5 ? '至少 5 人开局' : '开始游戏'}
          </button>
        </div>
        {startError !== null && (
          <p className="scr-error" role="alert">
            {startError}
          </p>
        )}
        <p className="scr-caption">标准局 12 人：4 狼人 · 4 村民 · 预言家 · 女巫 · 猎人 · 白痴</p>
      </section>
    </main>
  );
}
