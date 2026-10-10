import { useState } from 'react';
import type { JSX } from 'react';

import type { Seat, SeatView } from '../../types';
import { SeatPicker } from '../SeatPicker/SeatPicker';
import styles from './GuardPad.module.css';

export interface GuardPadOptions {
  maySelfProtect: boolean;
  mayPass: boolean;
  repeatBan: boolean;
  lastProtected: number | null;
}

export interface GuardPadProps {
  /** The viewer's own seat — the 自守 target. */
  self: Seat;
  /** Per-board guard knobs as the server projected them onto the view. */
  options: GuardPadOptions;
  /** Living others offered as protection targets. */
  targets: SeatView[];
  onProtect: (target: Seat) => void;
  onPass: () => void;
  disabled?: boolean;
}

/**
 * Night pad for the guard: protect one player (or himself, 自守) from the
 * wolves' knife, or pass (空守). The repeat-banned seat — last night's
 * protectee when 连守 is on — stays unpickable; the pass button only shows
 * when the board allows an empty protect.
 */
export function GuardPad({
  self,
  options,
  targets,
  onProtect,
  onPass,
  disabled = false,
}: GuardPadProps): JSX.Element {
  const [selected, setSelected] = useState<Seat | null>(null);
  const selfSelected = selected === self;
  const banned = options.repeatBan ? options.lastProtected : null;

  function confirm(): void {
    if (selfSelected) onProtect(self);
    else if (selected !== null) onProtect(selected);
  }

  return (
    <section className={styles.pad} aria-label="守卫守护">
      <h3 className={styles.title}>守卫行动</h3>
      <p className={styles.hint}>
        {options.repeatBan && options.lastProtected !== null
          ? `上夜守护了 ${options.lastProtected}号，本夜不能重复守护同一人。`
          : '选择今晚守护的玩家，使其免受狼人袭击。'}
      </p>
      <SeatPicker
        options={targets}
        selected={selfSelected ? null : selected}
        onSelect={setSelected}
        disabled={disabled}
        isDisabled={(seat) => seat === banned}
      />
      <div className={styles.actions}>
        {options.maySelfProtect && (
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={selfSelected}
            disabled={disabled}
            onClick={() => setSelected(selfSelected ? null : self)}
          >
            自守
          </button>
        )}
        <button
          type="button"
          className={styles.button}
          disabled={disabled || (selected === null && !selfSelected)}
          onClick={confirm}
        >
          {selfSelected
            ? `守护自己（${self}号）`
            : selected === null
              ? '选择守护对象'
              : `守护 ${selected}号`}
        </button>
        {options.mayPass && (
          <button type="button" className={styles.pass} disabled={disabled} onClick={onPass}>
            空守
          </button>
        )}
      </div>
    </section>
  );
}
