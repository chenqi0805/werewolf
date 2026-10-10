import type { JSX } from 'react';

import type { Seat, SeatView } from '../../types';
import { SeatChip } from '../SeatChip/SeatChip';
import styles from './SeatPicker.module.css';

export interface SeatPickerProps {
  /** Candidate seats in display order; already filtered by the composition layer. */
  options: SeatView[];
  selected?: Seat | null;
  onSelect: (seat: Seat) => void;
  disabled?: boolean;
  /** Per-seat opt-out (e.g. the guard's repeat-banned protectee) — chips render inert. */
  isDisabled?: (seat: Seat) => boolean;
}

/** Compact wrapped grid of clickable seat chips for targeting decisions. */
export function SeatPicker({
  options,
  selected = null,
  onSelect,
  disabled = false,
  isDisabled,
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
          disabled={disabled || (isDisabled?.(view.seat) ?? false)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
