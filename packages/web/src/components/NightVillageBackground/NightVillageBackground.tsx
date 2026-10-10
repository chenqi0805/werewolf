import type { JSX } from 'react';

import backdropUrl from '../../assets/night-village.webp';
import styles from './NightVillageBackground.module.css';

/**
 * Full-viewport art layer beneath the live game board. Fixed and out of flow
 * (no layout shift), hidden from assistive tech and click-through; the scrim
 * keeps panels and captions readable over the art in both themes. Requires the
 * host screen to own a stacking context (`.scr-page--village`).
 */
export function NightVillageBackground(): JSX.Element {
  return (
    <div className={styles.backdrop} aria-hidden="true">
      <img className={styles.image} src={backdropUrl} alt="" decoding="async" />
      <div className={styles.scrim} />
    </div>
  );
}
