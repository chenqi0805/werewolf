import type { JSX } from 'react';

import type { Seat, SeatView } from '../../types';
import { SeatChip } from '../SeatChip/SeatChip';
import styles from './SeatGrid.module.css';

export interface SeatGridProps {
  /** State for joined seats; slots 1..12 always render (missing ones are empty). */
  seats: SeatView[];
  /** Presence makes live seats clickable and emits the seat number. */
  onSelect?: (seat: Seat) => void;
  selected?: Seat | null;
  /** Seat numbers that may not be chosen right now (still rendered clickable-through). */
  ineligible?: ReadonlySet<Seat>;
  /** Lock the whole grid (e.g. not this player's turn). */
  disabled?: boolean;
  /** Show publicly revealed role tags. */
  showRoles?: boolean;
}

export const SEAT_COUNT = 12;

/** The 12-seat board in seat order, showing life, badge, speech, and reveal state. */
export function SeatGrid({
  seats,
  onSelect,
  selected = null,
  ineligible,
  disabled = false,
  showRoles = false,
}: SeatGridProps): JSX.Element {
  const bySeat = new Map(seats.map((view) => [view.seat, view]));
  return (
    <div className={styles.grid} aria-label="座位表">
      {Array.from({ length: SEAT_COUNT }, (_, index) => {
        const seat = index + 1;
        const view = bySeat.get(seat);
        if (!view) {
          return (
            <div key={seat} className={styles.empty}>
              {seat}号
            </div>
          );
        }
        const blocked = ineligible?.has(seat) ?? false;
        return (
          <SeatChip
            key={seat}
            view={view}
            showRole={showRoles}
            selected={selected === seat}
            disabled={disabled || blocked || !view.alive || onSelect === undefined}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}
