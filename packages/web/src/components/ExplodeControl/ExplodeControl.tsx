import { useState } from 'react';
import type { JSX } from 'react';

import styles from './ExplodeControl.module.css';

export interface ExplodeControlProps {
  onExplode: () => void;
  disabled?: boolean;
}

/**
 * The plain wolf's 自爆: a two-step affordance (「自爆」 → irreversible
 * confirm) because firing reveals the wolf, kills them, and ends the day
 * immediately — there is no undo on the wire. Unlike the 白狼王's
 * DestructControl there is no target to pick: the blast takes no one.
 */
export function ExplodeControl({ onExplode, disabled = false }: ExplodeControlProps): JSX.Element {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <section className={styles.bar} aria-label="狼人自爆">
        <p className={styles.note}>你可以自爆揭示身份，白天立即结束进入夜晚。</p>
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
    <section className={styles.flow} aria-label="狼人自爆">
      <h3 className={styles.title}>自爆 · 确认出局</h3>
      <div className={styles.actions}>
        <button type="button" className={styles.confirm} disabled={disabled} onClick={onExplode}>
          确认自爆
        </button>
        <button
          type="button"
          className={styles.cancel}
          disabled={disabled}
          onClick={() => setOpen(false)}
        >
          取消
        </button>
      </div>
      <p className={styles.warning}>自爆不可撤销：你将立即出局，白天结束进入夜晚。</p>
    </section>
  );
}
