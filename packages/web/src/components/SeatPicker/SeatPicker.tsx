import type { JSX } from 'react';

import type { Seat, SeatView } from '../../types';
import { SeatChip } from '../SeatChip/SeatChip';
import styles from './SeatPicker.module.css';

export interface SeatPickerProps {
  /** Candidate seats in display order; already filtered by the composition layer. */
  options: SeatView[];
  selected: Seat | null;
  onSelect: (seat: Seat) => void;
  disabled?: boolean;
}

/** Compact wrapped grid of clickable seat chips for targeting decisions. */
export function SeatPicker({
  options,
  selected,
  onSelect,
  disabled = false,
}: SeatPickerProps): JSX.Element {
  if (options.length === 0) {
    return <p className={styles.empty}>没有可选目标</p>;
  }
  return (
    <div className={styles.wrap} role="group" aria-label="选择目标">
      {options.map((view) => (
        <SeatChip
          key={view.seat}
          view={view}
          selected={selected === view.seat}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
