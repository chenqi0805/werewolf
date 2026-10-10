import { useState } from 'react';
import type { JSX } from 'react';

import type { Seat, SeatView } from '../../types';
import { SeatPicker } from '../SeatPicker/SeatPicker';
import styles from './DestructControl.module.css';

export interface DestructControlProps {
  /** Living others the blast can take (the king himself never qualifies). */
  targets: SeatView[];
  onDestruct: (target: Seat) => void;
  disabled?: boolean;
}

/**
 * The 白狼王's self-destruct: a two-step affordance (「自爆」 → pick a target
 * → irreversible confirm) because firing kills the king, takes the target,
 * and ends the day immediately — there is no undo on the wire.
 */
export function DestructControl({
  targets,
  onDestruct,
  disabled = false,
}: DestructControlProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Seat | null>(null);

  function reset(): void {
    setOpen(false);
    setSelected(null);
  }

  if (!open) {
    return (
      <section className={styles.bar} aria-label="白狼王自爆">
        <p className={styles.note}>你可以自爆带走一名玩家，白天立即结束进入夜晚。</p>
        <button
          type="button"
          className={styles.arm}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          自爆
        </button>
      </section>
    );
  }

  return (
    <section className={styles.flow} aria-label="白狼王自爆">
      <h3 className={styles.title}>自爆 · 选择带走的目标</h3>
      {targets.length === 0 ? (
        <p className={styles.note}>场上已无可带走的目标。</p>
      ) : (
        <SeatPicker
          options={targets}
          selected={selected}
          onSelect={setSelected}
          disabled={disabled}
        />
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.confirm}
          disabled={disabled || selected === null}
          onClick={() => selected !== null && onDestruct(selected)}
        >
          {selected === null ? '选择目标' : `确认自爆并带走 ${selected}号`}
        </button>
        <button type="button" className={styles.cancel} disabled={disabled} onClick={reset}>
          取消
        </button>
      </div>
      <p className={styles.warning}>自爆不可撤销：你将立即出局，与所选目标一同倒下。</p>
    </section>
  );
}
