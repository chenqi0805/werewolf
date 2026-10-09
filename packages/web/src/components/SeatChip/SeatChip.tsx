import type { JSX } from 'react';

import { ROLE_META } from '../../roles';
import type { Seat, SeatView } from '../../types';
import styles from './SeatChip.module.css';

export interface SeatChipProps {
  view: SeatView;
  /** Render as a button and emit the seat number on click. Omit for a static status chip. */
  onSelect?: (seat: Seat) => void;
  selected?: boolean;
  disabled?: boolean;
  /** Show the publicly revealed role tag under the name. */
  showRole?: boolean;
}

/** One seat as a compact chip: number, name, and status affordances. */
export function SeatChip({
  view,
  onSelect,
  selected = false,
  disabled = false,
  showRole = false,
}: SeatChipProps): JSX.Element {
  const meta = view.role !== undefined ? ROLE_META[view.role] : null;
  const interactive = onSelect !== undefined && !disabled;
  const classes = [
    styles.chip,
    interactive && styles.clickable,
    selected && styles.selected,
    !view.alive && styles.dead,
    view.isSpeaking && styles.speaking,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      {view.isSheriff ? (
        <span className={styles.sheriffBadge} title="警长">
          警
        </span>
      ) : null}
      {!view.alive ? (
        <span className={styles.deadTag}>出局</span>
      ) : view.revealedIdiot ? (
        <span className={styles.idiotTag}>已翻牌</span>
      ) : null}
      <span className={styles.seatNumber}>{view.seat}号</span>
      <span className={styles.seatName}>{view.name}</span>
      {showRole && meta ? (
        <span className={styles.roleTag} style={{ color: `var(${meta.accent})` }}>
          {meta.label}
        </span>
      ) : null}
      {view.isSelf ? <span className={styles.selfTag}>你</span> : null}
    </>
  );

  const label = `${view.seat}号 ${view.name}${view.alive ? '' : '，已出局'}${
    view.isSheriff ? '，警长' : ''
  }${meta ? `，${meta.label}` : ''}`;

  if (!interactive) {
    return (
      <div className={classes} aria-label={label}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={classes}
      onClick={() => onSelect(view.seat)}
      aria-pressed={selected}
      aria-label={label}
    >
      {content}
    </button>
  );
}
