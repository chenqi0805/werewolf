import type { JSX } from 'react';

import { ROLE_META } from '../../roles';
import type { PlayerReveal, WinSide } from '../../types';
import styles from './GameOverReveal.module.css';

export interface GameOverRevealProps {
  winner: WinSide;
  /** Every seat with their role and survival state — the full reveal. */
  reveals: PlayerReveal[];
  /** Day number the game ended on. */
  dayNumber: number;
  onBackToLobby?: () => void;
}

const WINNER_LABEL: Record<WinSide, string> = {
  wolves: '狼人阵营胜利',
  good: '好人阵营胜利',
};

/** Game-over screen: winner banner plus the full role reveal of every seat. */
export function GameOverReveal({
  winner,
  reveals,
  dayNumber,
  onBackToLobby,
}: GameOverRevealProps): JSX.Element {
  const isWolfWin = winner === 'wolves';
  return (
    <section className={styles.reveal} aria-label="游戏结束">
      <div className={`${styles.banner} ${isWolfWin ? styles.wolfWin : styles.goodWin}`}>
        <span className={styles.winnerLabel}>{WINNER_LABEL[winner]}</span>
        <span className={styles.dayLabel}>第 {dayNumber} 天结束</span>
      </div>
      <ul className={styles.seats}>
        {reveals.map((reveal) => {
          const meta = ROLE_META[reveal.role];
          return (
            <li
              key={reveal.seat}
              className={[
                styles.seat,
                reveal.alive ? styles.alive : styles.dead,
                reveal.role === 'werewolf' && styles.wolfSeat,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className={styles.seatNumber}>{reveal.seat}号</span>
              <span className={styles.roleName} data-team={meta.team}>
                {meta.label}
              </span>
              <span className={styles.fate}>{reveal.alive ? '存活' : '出局'}</span>
              {reveal.hasBadge ? <span className={styles.badge}>警徽</span> : null}
            </li>
          );
        })}
      </ul>
      {onBackToLobby ? (
        <button type="button" className={styles.backButton} onClick={onBackToLobby}>
          返回房间
        </button>
      ) : null}
    </section>
  );
}
