import { useState } from 'react';
import type { JSX } from 'react';
import type { PlayerView } from '@werewolf/server';

import { occupiedCountOf, roomErrorText, seatViewsOf } from '../client/adapters';
import { isValidInviteEmail } from '../client/invite';
import {
  AckError,
  addBot,
  leaveRoom,
  removeBot,
  sendInvite,
  startGame,
  type GameSocket,
} from '../client/socketClient';
import { SeatGrid } from '../components';
import type { SeatView } from '../types';
import { TutorialScreen } from './TutorialScreen';

/** zh copy for the room:invite ack codes; room codes fall through to roomErrorText. */
const INVITE_ERROR_TEXT: Record<string, string> = {
  INVALID_EMAIL: '邮箱地址无效，请检查',
  INVITE_UNAVAILABLE: '邮件邀请暂未配置',
  INVITE_BUSY: '上一封邀请还在发送，请稍候',
  INVITE_RATE_LIMITED: '本局邀请次数已用完',
  INVITE_ERROR: '邀请发送失败，请重试',
};

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
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteSentTo, setInviteSentTo] = useState<string | null>(null);

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
    // Seat-less viewers hold no seat to free — `room:leave` is seat-scoped
    // and would ack NOT_IN_ROOM. Their quit is client-side only.
    if (view.you.seat === null) {
      onQuit();
      return;
    }
    try {
      await leaveRoom(socket);
      onQuit();
    } catch (err) {
      setActionError(err instanceof Error ? roomErrorText(err.message) : '退出失败，请重试');
    }
  }

  async function handleAddBot(): Promise<void> {
    setActionError(null);
    try {
      await addBot(socket);
    } catch (err) {
      setActionError(err instanceof Error ? roomErrorText(err.message) : '添加AI失败，请重试');
    }
  }

  async function handleRemoveBot(seat: number): Promise<void> {
    setActionError(null);
    try {
      await removeBot(socket, seat);
    } catch (err) {
      setActionError(err instanceof Error ? roomErrorText(err.message) : '移除AI失败，请重试');
    }
  }

  async function handleInvite(): Promise<void> {
    setInviteSentTo(null);
    setActionError(null);
    const email = inviteEmail.trim();
    // The obvious-mistake gate: a malformed address never leaves the browser.
    if (!isValidInviteEmail(email)) {
      setActionError(INVITE_ERROR_TEXT['INVALID_EMAIL'] ?? null);
      return;
    }
    setInviteBusy(true);
    try {
      await sendInvite(socket, email);
      setInviteEmail('');
      setInviteSentTo(email);
    } catch (err) {
      const code = err instanceof AckError ? err.code : 'INVITE_ERROR';
      setActionError(INVITE_ERROR_TEXT[code] ?? roomErrorText(code));
    } finally {
      setInviteBusy(false);
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
        <p className="scr-subtitle">
          把房间号发给朋友，人不满可用 AI 补位，人满后任意玩家可以开局。
        </p>
        {view.inviteAvailable === true && (
          <div role="group" aria-label="邮件邀请" className="scr-row">
            <input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="朋友的邮箱"
              aria-label="朋友邮箱"
              type="email"
              maxLength={254}
              disabled={inviteBusy}
            />
            <button
              type="button"
              onClick={handleInvite}
              disabled={inviteBusy || inviteEmail.trim() === ''}
            >
              发送邀请
            </button>
          </div>
        )}
        {inviteSentTo !== null && (
          <p className="scr-caption" role="status">
            邀请已发送给 {inviteSentTo}
          </p>
        )}
        <SeatGrid seats={seats} />
        <div className="scr-row">
          <button type="button" onClick={handleAddBot} disabled={joined >= 12}>
            添加AI玩家
          </button>
          {seats
            .filter((s) => s.isBot)
            .map((s) => (
              <button key={s.seat} type="button" onClick={() => handleRemoveBot(s.seat)}>
                移除 {s.name}
              </button>
            ))}
        </div>
        <div className="scr-actions">
          <button type="button" onClick={handleStart} disabled={joined < 12}>
            {joined < 12 ? '人满后开局' : '开始游戏'}
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
