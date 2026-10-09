import type { JSX } from 'react';

import { ROLE_META } from '../roles';
import { ROLE_GUIDES } from '../roleGuides';
// The screen reuses the shared scr-* layout classes; App imports this too,
// but Storybook mounts the screen without App — so import it here as well.
import './screens.css';
import styles from './TutorialScreen.module.css';

export interface TutorialScreenProps {
  /** Return to the previous screen (the lobby or the game board). */
  onClose: () => void;
  /** Render as a full-screen overlay above the game board (in-game help). */
  modal?: boolean;
}

/**
 * 玩法教程: one card per role — ability, win condition, playstyle tips.
 * Pure presentational; the lobby swaps to it full-page, the game board
 * overlays it as a modal so the running phase stays visible.
 */
export function TutorialScreen({ onClose, modal = false }: TutorialScreenProps): JSX.Element {
  const content = (
    <section className="scr-panel">
      <div className="scr-row scr-row--spread">
        <h1 className="scr-title">玩法教程</h1>
        <button type="button" onClick={onClose}>
          {modal ? '关闭' : '返回'}
        </button>
      </div>
      <p className="scr-subtitle">
        标准局 12 人：4 狼人 · 4 村民 · 预言家 · 女巫 · 猎人 ·
        白痴。熟悉每个角色的技能、胜利条件与打法。
      </p>
      <ul className={styles.guides}>
        {ROLE_GUIDES.map((guide) => (
          <li key={guide.role} className={`${styles.guide} ${styles[guide.role]}`}>
            <div className={styles.identity}>
              <span className={styles.monogram} aria-hidden="true">
                {ROLE_META[guide.role].monogram}
              </span>
              <span className={styles.teamTag}>
                {guide.team === 'wolves' ? '狼人阵营' : '好人阵营'}
              </span>
            </div>
            <div className={styles.body}>
              <h2 className={styles.roleLabel}>{guide.label}</h2>
              <p className={styles.ability}>{guide.ability}</p>
              <p className={styles.winLine}>
                <span className={styles.fieldLabel}>胜利条件</span>
                {guide.winLine}
              </p>
              <div>
                <span className={styles.fieldLabel}>打法提示</span>
                <ul className={styles.tips}>
                  {guide.tips.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );

  if (modal) {
    return (
      <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="玩法教程">
        <div className={styles.overlayInner}>{content}</div>
      </div>
    );
  }
  return <main className="scr-page">{content}</main>;
}
