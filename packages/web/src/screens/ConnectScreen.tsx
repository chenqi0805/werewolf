import { useState } from 'react';
import type { JSX } from 'react';
import type { Seat } from '@werewolf/engine';

import { AckError, createRoom, joinRoom, type GameSocket } from '../client/socketClient';

interface ConnectScreenProps {
  socket: GameSocket;
  /** Persist the session (room code, seat, token) after a successful join. */
  onSession: (session: { roomCode: string; seat: Seat | null; token: string | null }) => void;
}

const errorText: Record<string, string> = {
  ROOM_FULL: '房间已满（12 人）',
  GAME_RUNNING: '对局进行中，稍后再来',
  ROOM_NOT_FOUND: '房间不存在，检查房间号',
};

/**
 * Landing screen: create a room or join one by code. The ack payloads are
 * persisted by the App before the room screen mounts.
 */
export function ConnectScreen({ socket, onSession }: ConnectScreenProps): JSX.Element {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function describe(err: unknown): string {
    if (err instanceof AckError) return errorText[err.code] ?? `加入失败（${err.code}）`;
    return '连接失败，请重试';
  }

  async function handle(create: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (create) {
        const ack = await createRoom(socket);
        onSession({ roomCode: ack.roomCode, seat: ack.seat, token: ack.sessionToken });
      } else {
        const trimmed = code.trim();
        const ack = await joinRoom(socket, trimmed);
        if ('spectator' in ack) {
          onSession({ roomCode: trimmed, seat: null, token: null });
        } else {
          onSession({ roomCode: trimmed, seat: ack.seat, token: ack.sessionToken });
        }
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="scr-page scr-page--flush">
      <section className="scr-panel">
        <h1 className="scr-title">狼人杀 · 12人标准局</h1>
        <p className="scr-subtitle">创建房间后把房间号分享给其他 11 位玩家。</p>
        <div className="scr-actions">
          <button type="button" onClick={() => handle(true)} disabled={busy}>
            创建房间
          </button>
        </div>
        <div className="scr-row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="房间号"
            aria-label="房间号"
            maxLength={8}
          />
          <button type="button" onClick={() => handle(false)} disabled={busy || code.trim() === ''}>
            加入房间
          </button>
        </div>
        {error !== null && (
          <p className="scr-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
