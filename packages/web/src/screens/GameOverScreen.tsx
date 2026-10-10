import type { PlayerView } from '@werewolf/server';
import type { JSX } from 'react';

import { logToEntries, postgameStatsOf, revealsOf, winSideOf } from '../client/adapters';
import { requestPostgameAnalysis, type GameSocket } from '../client/socketClient';
import { DayLog, GameOverReveal, PostgameReview } from '../components';

/**
 * End-of-game screen: full reveal, winning side, the complete day log, and
 * the 复盘 section — deterministic stats plus the on-demand AI review, seen
 * identically by the living, the dead, and spectators. The socket prop is
 * optional so stories (and any composition without a socket) still render
 * the stats grid; without it the AI block starts disabled. `onExit` renders
 * the 返回主页 control — a client-side return to the main page; without it
 * the screen ends at the day log.
 */
export function GameOverScreen({
  view,
  socket,
  onExit,
}: {
  view: PlayerView;
  socket?: GameSocket | null;
  onExit?: () => void;
}): JSX.Element {
  const winner = view.winner ?? winSideOf(view);
  return (
    <main className="scr-page">
      <section className="scr-panel">
        <GameOverReveal winner={winner} reveals={revealsOf(view)} dayNumber={view.dayNumber} />
        <PostgameReview
          stats={postgameStatsOf(view)}
          winner={winner}
          onAnalyze={() => requestPostgameAnalysis(socket)}
          disabled={!socket}
        />
        <DayLog entries={logToEntries(view.log, view.board)} />
        {onExit && (
          <div className="scr-actions scr-actions--center">
            <button type="button" className="scr-exit" onClick={onExit}>
              返回主页
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
