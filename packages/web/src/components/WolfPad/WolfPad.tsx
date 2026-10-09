import { useState } from 'react';
import type { JSX } from 'react';

import type { Seat, SeatView } from '../../types';
import { SeatPicker } from '../SeatPicker/SeatPicker';
import styles from './WolfPad.module.css';

export interface WolfPadProps {
  /** Living co-wolves including this player — shown so the pack can confirm each other. */
  wolves: Seat[];
  /** Living non-wolf players the pack may target. */
  targets: SeatView[];
  /** The pack's current agreed target, shown for alignment; null = undecided or 空刀. */
  packTarget?: Seat | null;
  /** Confirmed kill target; null commits 空刀 (no kill tonight). */
  onConfirm: (target: Seat | null) => void;
  /** Locked while the pack hasn't settled or the phase window closed. */
  disabled?: boolean;
  disabledNote?: string;
}

/** Night pad for the wolves: agree on one victim, or pass the knife (空刀). */
export function WolfPad({
  wolves,
  targets,
  packTarget = null,
  onConfirm,
  disabled = false,
  disabledNote,
}: WolfPadProps): JSX.Element {
  const [selected, setSelected] = useState<Seat | null>(null);

  return (
    <section className={styles.pad} aria-label="狼人行动">
      <h3 className={styles.title}>狼人行动</h3>
      <div className={styles.row}>
        <span className={styles.rowLabel}>你的同伴</span>
        <span className={styles.wolfList}>{wolves.map((seat) => `${seat}号`).join('、')}</span>
      </div>
      {packTarget !== null ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>狼队意向</span>
          <span className={styles.packTarget}>{packTarget}号</span>
        </div>
      ) : null}
      <SeatPicker
        options={targets}
        selected={selected}
        onSelect={setSelected}
        disabled={disabled}
      />
      {disabled && disabledNote ? <p className={styles.note}>{disabledNote}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.decline}`}
          disabled={disabled}
          onClick={() => onConfirm(null)}
        >
          空刀
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={disabled || selected === null}
          onClick={() => selected !== null && onConfirm(selected)}
        >
          {selected === null ? '确认猎杀目标' : `确认猎杀 ${selected}号`}
        </button>
      </div>
    </section>
  );
}
