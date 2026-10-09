import { useState } from 'react';
import type { JSX } from 'react';
import type { PlayerView } from '@werewolf/server';

import { occupiedCountOf, roomErrorText, seatViewsOf } from '../client/adapters';
import { leaveRoom, startGame, type GameSocket } from '../client/socketClient';
import { SeatGrid } from '../components';
import type { SeatView } from '../types';
import { TutorialScreen } from './TutorialScreen';

interface LobbyScreenProps {
  view: PlayerView;
  roomCode: string;
  socket: GameSocket;
  /** Runs after the server frees the seat — returns the player to the connect screen. */
  onQuit: () => void;
}

/**
 * Pre-game waiting room: share the code, watch seats fill, start when ready.
 * The server rejects a start it does not allow; the code surfaces inline.
 */
export function LobbyScreen({ view, roomCode, socket, onQuit }: LobbyScreenProps): JSX.Element {
  const seats: SeatView[] = seatViewsOf(view);
  const joined = occupiedCountOf(seats);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);

  async function handleStart(): Promise<void> {
    setActionError(null);
    try {
      await startGame(socket);
    } catch (err) {
      setActionError(err instanceof Error ? roomErrorText(err.message) : '开局失败，请重试');
    }
  }

  async function handleQuit(): Promise<void> {
    setActionError(null);
    try {
      await leaveRoom(socket);
      onQuit();
    } catch (err) {
      setActionError(err instanceof Error ? roomErrorText(err.message) : '退出失败，请重试');
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
          <button type="button" onClick={handleQuit}>
            退出房间
          </button>
        </div>
        {actionError !== null && (
          <p className="scr-error" role="alert">
            {actionError}
          </p>
        )}
        <p className="scr-caption">标准局 12 人：4 狼人 · 4 村民 · 预言家 · 女巫 · 猎人 · 白痴</p>
      </section>
    </main>
  );
}
