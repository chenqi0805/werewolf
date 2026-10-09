import { useState } from 'react';
import type { JSX } from 'react';

import type { Seat, SeatView, SeerResult } from '../../types';
import { SeatPicker } from '../SeatPicker/SeatPicker';
import styles from './SeerPad.module.css';

export interface SeerPadProps {
  /** The seer's private check history, in check order. */
  results: SeerResult[];
  /** Living, not-yet-checked players. */
  targets: SeatView[];
  onCheck: (target: Seat) => void;
  disabled?: boolean;
}

/** Night pad for the seer: check one player's camp; results stay private. */
export function SeerPad({
  results,
  targets,
  onCheck,
  disabled = false,
}: SeerPadProps): JSX.Element {
  const [selected, setSelected] = useState<Seat | null>(null);

  return (
    <section className={styles.pad} aria-label="预言家查验">
      <h3 className={styles.title}>预言家行动</h3>
      {results.length > 0 ? (
        <ul className={styles.results} aria-label="查验记录">
          {results.map((result) => (
            <li key={result.seat} className={styles.resultRow}>
              <span className={styles.resultSeat}>{result.seat}号</span>
              <span className={result.isWolf ? styles.resultWolf : styles.resultGood}>
                {result.isWolf ? '狼人' : '好人'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.emptyResults}>还没有查验记录</p>
      )}
      <SeatPicker
        options={targets}
        selected={selected}
        onSelect={setSelected}
        disabled={disabled}
      />
      <button
        type="button"
        className={styles.button}
        disabled={disabled || selected === null}
        onClick={() => selected !== null && onCheck(selected)}
      >
        {selected === null ? '选择查验对象' : `查验 ${selected}号`}
      </button>
      <p className={styles.hint}>查验结果仅你可见</p>
    </section>
  );
}
