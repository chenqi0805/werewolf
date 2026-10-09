import { useState } from 'react';
import type { JSX } from 'react';

import { healBlockReason, poisonBlockReason } from '../../logic';
import type { Seat, SeatView } from '../../types';
import { SeatPicker } from '../SeatPicker/SeatPicker';
import styles from './WitchPad.module.css';

export interface WitchPadProps {
  self: Seat;
  /** Tonight's wolf victim; null = 空刀 (nobody to save). */
  killTarget: Seat | null;
  /** Whether the witch has already spent her heal potion. */
  healUsed: boolean;
  /** Whether the witch has already spent her poison potion. */
  poisonUsed: boolean;
  /** Self-save rule: allowed on night 1 only. */
  maySelfSave: boolean;
  /** Living players (composition excludes the witch herself). */
  targets: SeatView[];
  onHeal: () => void;
  onPoison: (target: Seat) => void;
  onSkip: () => void;
  disabled?: boolean;
}

/** Night pad for the witch: save tonight's victim, poison someone, or skip. */
export function WitchPad({
  self,
  killTarget,
  healUsed,
  poisonUsed,
  maySelfSave,
  targets,
  onHeal,
  onPoison,
  onSkip,
  disabled = false,
}: WitchPadProps): JSX.Element {
  const [poisonTarget, setPoisonTarget] = useState<Seat | null>(null);
  const healReason = healBlockReason(killTarget, self, healUsed, maySelfSave);
  const poisonReason = poisonBlockReason(poisonUsed);
  const poisonOptions = targets.filter((view) => view.seat !== self);

  return (
    <section className={styles.pad} aria-label="女巫用药">
      <h3 className={styles.title}>女巫行动</h3>
      <p className={styles.victim}>
        {killTarget === null ? '今晚空刀，无人被杀' : `今晚倒牌：${killTarget}号`}
      </p>
      <div className={styles.potions}>
        <div className={styles.potion}>
          <span className={`${styles.potionTitle} ${styles.heal}`}>解药</span>
          <p className={styles.potionState}>{healReason ?? '可以救起今晚的倒牌'}</p>
          <button
            type="button"
            className={`${styles.button} ${styles.healButton}`}
            disabled={disabled || healReason !== null}
            onClick={onHeal}
          >
            {killTarget === null ? '使用解药' : `救活 ${killTarget}号`}
          </button>
        </div>
        <div className={styles.potion}>
          <span className={`${styles.potionTitle} ${styles.poison}`}>毒药</span>
          {poisonReason === null ? (
            <SeatPicker
              options={poisonOptions}
              selected={poisonTarget}
              onSelect={setPoisonTarget}
              disabled={disabled}
            />
          ) : (
            <p className={styles.potionState}>{poisonReason}</p>
          )}
          <button
            type="button"
            className={`${styles.button} ${styles.poisonButton}`}
            disabled={disabled || poisonReason !== null || poisonTarget === null}
            onClick={() => poisonTarget !== null && onPoison(poisonTarget)}
          >
            {poisonTarget === null ? '选择施毒目标' : `毒杀 ${poisonTarget}号`}
          </button>
        </div>
      </div>
      <button type="button" className={styles.skip} disabled={disabled} onClick={onSkip}>
        今晚不用药
      </button>
    </section>
  );
}
