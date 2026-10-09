import type { JSX } from 'react';

import { ROLE_META } from '../../roles';
import type { Role } from '../../types';
import styles from './RoleCard.module.css';

export interface RoleCardProps {
  role: Role;
  seat: number;
  name?: string;
  /** Face-down state before the player flips it. */
  faceDown?: boolean;
}

/** The player's own identity card, or its face-down back. */
export function RoleCard({ role, seat, name, faceDown = false }: RoleCardProps): JSX.Element {
  if (faceDown) {
    return (
      <div className={`${styles.card} ${styles.faceDown}`} aria-label={`${seat}号的身份牌，未翻开`}>
        <span className={styles.backMoon}>月</span>
        <span className={styles.backLabel}>身份牌 · {seat}号</span>
        <span className={styles.backHint}>翻开确认你的身份</span>
      </div>
    );
  }

  const meta = ROLE_META[role];
  return (
    <div className={`${styles.card} ${styles[role]}`} aria-label={`${seat}号的身份：${meta.label}`}>
      <span className={styles.monogram}>{meta.monogram}</span>
      <span className={styles.roleLabel}>{meta.label}</span>
      <span className={styles.teamTag}>{meta.team === 'wolves' ? '狼人阵营' : '好人阵营'}</span>
      <p className={styles.ability}>{meta.ability}</p>
      <span className={styles.holder}>
        {seat}号{name ? ` · ${name}` : ''}
      </span>
    </div>
  );
}
