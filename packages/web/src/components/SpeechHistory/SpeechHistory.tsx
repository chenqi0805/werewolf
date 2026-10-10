import type { JSX } from 'react';

import type { SpeechRecord } from '../../types';
import styles from './SpeechHistory.module.css';

export interface SpeechHistoryProps {
  /** Day-grouped speech records, days ascending — `speechByDayOf(view)`. */
  groups: Array<{ day: number; records: SpeechRecord[] }>;
}

const CONTEXT_LABELS: Record<SpeechRecord['context'], string> = {
  speech: '发言',
  'sheriff-speech': '竞选演讲',
  'last-words': '遗言',
  'pk-speech': 'PK演讲',
};

/**
 * The permanent speech record: every accepted speech, grouped by game day.
 * Public by construction — the server only ever sends events this viewer
 * may see, so players, the dead, and spectators all read the same panel.
 */
export function SpeechHistory({ groups }: SpeechHistoryProps): JSX.Element {
  return (
    <section className={styles.history} aria-label="发言记录">
      <h3 className={styles.title}>发言记录</h3>
      {groups.length === 0 ? (
        <p className={styles.empty}>还没有发言记录</p>
      ) : (
        groups.map((group) => (
          <div key={group.day} className={styles.group}>
            <h4 className={styles.groupLabel}>第 {group.day} 天</h4>
            <ul className={styles.recordList}>
              {group.records.map((record, index) => (
                <li key={`${record.context}-${record.seat}-${index}`} className={styles.record}>
                  <span className={styles.recordMeta}>
                    {record.name} · {CONTEXT_LABELS[record.context]}
                  </span>
                  <p className={styles.recordText}>{record.text}</p>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
