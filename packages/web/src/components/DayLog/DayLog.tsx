import type { JSX } from 'react';

import { groupEntriesByDay } from '../../logic';
import type { LogEntry } from '../../types';
import styles from './DayLog.module.css';

export interface DayLogProps {
  entries: LogEntry[];
}

/**
 * Chronological game log, grouped by day number. The server only ever sends
 * events this viewer may see, so no private/public filter lives here.
 */
export function DayLog({ entries }: DayLogProps): JSX.Element {
  const groups = groupEntriesByDay(entries);

  return (
    <section className={styles.log} aria-label="对局记录">
      <h3 className={styles.title}>对局记录</h3>
      {groups.length === 0 ? (
        <p className={styles.empty}>游戏尚未开始</p>
      ) : (
        groups.map((group) => (
          <div key={group.day} className={styles.group}>
            <h4 className={styles.groupLabel}>第 {group.day} 天</h4>
            <ul className={styles.entryList}>
              {group.entries.map((entry) => (
                <li key={entry.id} className={styles.entry}>
                  <span className={styles.entryText}>{entry.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
