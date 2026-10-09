import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { createGameSocket, rejoinRoom, type GameSocket } from './client/socketClient';
import { clearSession, loadSession, saveSession } from './client/session';
import { useGame } from './client/useGame';
import { ConnectScreen } from './screens/ConnectScreen';
import { GameOverScreen } from './screens/GameOverScreen';
import { GameScreen } from './screens/GameScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import './screens/screens.css';

interface SessionDraft {
  roomCode: string;
  seat: number | null;
  token: string | null;
}

/**
 * App shell: one socket for the page lifetime, the live game store, and the
 * screen router. Identity persists in localStorage — every (re)connect runs
 * the rejoin handshake so a refresh or transport drop reattaches the seat.
 */
export function App(): JSX.Element {
  const [socket] = useState<GameSocket>(() => createGameSocket());
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [dropped, setDropped] = useState(false);
  const { store, send } = useGame(socket);
  const { view, lastError, sessionLost } = store;

  useEffect(() => {
    const attach = (): void => {
      setDropped(false);
      const session = loadSession(window.localStorage);
      if (session !== null) {
        rejoinRoom(socket, session.roomCode, session.sessionToken)
          .then(() => setRoomCode(session.roomCode))
          .catch(() => {
            // Token no longer attaches (room gone): start over cleanly.
            clearSession(window.localStorage);
            setRoomCode(null);
          });
      }
    };
    const drop = (): void => setDropped(true);
    socket.on('connect', attach);
    socket.on('disconnect', drop);
    return () => {
      socket.off('connect', attach);
      socket.off('disconnect', drop);
    };
  }, [socket]);

  useEffect(() => {
    if (sessionLost !== null) {
      clearSession(window.localStorage);
      setRoomCode(null);
    }
  }, [sessionLost]);

  function enterRoom(draft: SessionDraft): void {
    if (draft.seat !== null && draft.token !== null) {
      saveSession(window.localStorage, {
        roomCode: draft.roomCode,
        seat: draft.seat,
        sessionToken: draft.token,
      });
    }
    setRoomCode(draft.roomCode);
  }

  // Night board dark, day board light — the phase drives the theme.
  const theme = view?.phase === 'night' ? 'dark' : 'light';

  let screen: JSX.Element;
  if (roomCode === null) {
    screen = <ConnectScreen socket={socket} onSession={enterRoom} />;
  } else if (view === null) {
    screen = (
      <main className="scr-page scr-page--flush">
        <section className="scr-panel">
          <p className="scr-empty">{dropped ? '连接已断开，正在重连…' : '连接服务器中…'}</p>
        </section>
      </main>
    );
  } else if (view.step.kind === 'lobby') {
    screen = (
      <LobbyScreen
        view={view}
        roomCode={roomCode}
        socket={socket}
        onQuit={() => {
          // The seat is freed server-side; the stale token must not reattach.
          clearSession(window.localStorage);
          setRoomCode(null);
        }}
      />
    );
  } else if (view.step.kind === 'game-over') {
    screen = <GameOverScreen view={view} />;
  } else {
    screen = <GameScreen view={view} roomCode={roomCode} send={send} socket={socket} />;
  }

  return (
    <div className="theme-scope" data-theme={theme}>
      {dropped && roomCode !== null && (
        <p className="scr-banner" role="status">
          连接已断开，正在重连…
        </p>
      )}
      {lastError !== null && (
        <p className="scr-error" role="alert">
          {lastError.message}
        </p>
      )}
      {screen}
    </div>
  );
}
