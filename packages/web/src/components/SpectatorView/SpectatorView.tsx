import type { JSX } from 'react';

import type { SpeechMessage, Seat, SeatView } from '../../types';
import { SeatGrid } from '../SeatGrid/SeatGrid';
import { SpeechPanel } from '../SpeechPanel/SpeechPanel';
import styles from './SpectatorView.module.css';

export interface SpectatorViewProps {
  /** All 12 seats with public info only. */
  seats: SeatView[];
  /** The seat currently in their speech slot; null outside speech. */
  speakingSeat: Seat | null;
  /** Public speech transcript. */
  messages: SpeechMessage[];
  dayNumber: number;
  /** Short phase caption, e.g. 「发言中」. */
  phaseCaption: string;
}

/** Late-join and finished-room view: full public board, no actions, no role info. */
export function SpectatorView({
  seats,
  speakingSeat,
  messages,
  dayNumber,
  phaseCaption,
}: SpectatorViewProps): JSX.Element {
  return (
    <section className={styles.view} aria-label="观战视角">
      <header className={styles.header}>
        <span className={styles.badge}>观战中</span>
        <span className={styles.caption}>
          第 {dayNumber} 天 · {phaseCaption} · 仅公开信息
        </span>
      </header>
      <SeatGrid seats={seats} disabled={true} />
      <SpeechPanel
        messages={messages}
        speakingSeat={speakingSeat}
        mySeat={null}
        canSpeak={false}
        disabled={true}
        hint="观战视角，无法发言"
      />
    </section>
  );
}
