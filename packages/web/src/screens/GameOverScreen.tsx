import type { PlayerView } from '@werewolf/server';
import type { JSX } from 'react';

import { logToEntries, revealsOf, winSideOf } from '../client/adapters';
import { DayLog, GameOverReveal } from '../components';

/** End-of-game screen: full reveal, winning side, and the complete day log. */
export function GameOverScreen({ view }: { view: PlayerView }): JSX.Element {
  const winner = view.winner ?? winSideOf(view);
  return (
    <main className="scr-page">
      <section className="scr-panel">
        <GameOverReveal winner={winner} reveals={revealsOf(view)} dayNumber={view.dayNumber} />
        <DayLog entries={logToEntries(view.log)} />
      </section>
    </main>
  );
}
