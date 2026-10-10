import { useState } from 'react';
import type { JSX } from 'react';

import type { StrategyReply } from '@werewolf/server';

import { AckError } from '../../client/socketClient';
import { ROLE_META } from '../../roles';
import type { Role, SpeechRecord } from '../../types';
import styles from './StrategyPanel.module.css';

export interface StrategyPanelProps {
  /** The viewer's own role — the advisor's frame of reference. */
  role: Role;
  /** Day-grouped public speech record — `speechByDayOf(view)`. */
  dayRecords: Array<{ day: number; records: SpeechRecord[] }>;
  /** Injected assistant request; GameScreen wires it to `requestStrategy(socket)`. */
  onSuggest: () => Promise<StrategyReply>;
  disabled?: boolean;
}

type PanelState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'suggestions'; reply: StrategyReply }
  | { phase: 'unconfigured' }
  | { phase: 'error'; message: string };

/** Ack codes get player-facing zh copy; anything unknown keeps its code visible. */
const ERROR_LABELS: Record<string, string> = {
  RATE_LIMITED: '本回合的建议次数已用完（每回合 3 次）。',
  ASSISTANT_BUSY: '助手正在处理请求，请稍后再试。',
  NOT_YOUR_TURN: '现在不是你的发言回合。',
  NO_HISTORY: '还没有发言记录可以参考。',
};

function errorTextOf(error: unknown): string {
  if (error instanceof AckError) return ERROR_LABELS[error.code] ?? `助手出错（${error.code}）`;
  return '网络异常，请稍后再试。';
}

function recordCountOf(dayRecords: StrategyPanelProps['dayRecords']): number {
  return dayRecords.reduce((count, group) => count + group.records.length, 0);
}

/**
 * The opt-in AI speech-strategy advisor, shown next to SpeechPanel while it
 * is this viewer's turn to speak. Pure: the request arrives as an injected
 * promise prop, so stories stub it like `onSend`. 未配置 is a distinct state
 * — the server acks ASSISTANT_UNAVAILABLE when no provider is configured.
 */
export function StrategyPanel({
  role,
  dayRecords,
  onSuggest,
  disabled = false,
}: StrategyPanelProps): JSX.Element {
  const [state, setState] = useState<PanelState>({ phase: 'idle' });

  const request = (): void => {
    setState({ phase: 'loading' });
    onSuggest()
      .then((reply) => setState({ phase: 'suggestions', reply }))
      .catch((error: unknown) =>
        setState(
          error instanceof AckError && error.code === 'ASSISTANT_UNAVAILABLE'
            ? { phase: 'unconfigured' }
            : { phase: 'error', message: errorTextOf(error) },
        ),
      );
  };

  const meta = ROLE_META[role];
  const count = recordCountOf(dayRecords);

  return (
    <section className={styles.panel} aria-label="AI 发言建议">
      <div className={styles.header}>
        <h3 className={styles.title}>AI 发言建议</h3>
        <span className={styles.roleTag} style={{ color: `var(${meta.accent})` }}>
          {meta.label}视角
        </span>
      </div>
      <div className={styles.body} aria-live="polite">
        {state.phase === 'idle' && (
          <>
            <p className={styles.note}>结合你的身份和此前的发言记录，帮你想好这一轮怎么说。</p>
            <button type="button" className={styles.ask} onClick={request} disabled={disabled}>
              请求建议
            </button>
          </>
        )}
        {state.phase === 'loading' && (
          <p className={`${styles.note} ${styles.loading}`}>AI 正在阅读发言记录…</p>
        )}
        {state.phase === 'suggestions' && (
          <>
            <p className={styles.sectionLabel}>可照念的发言要点</p>
            <ul className={styles.lines}>
              {state.reply.lines.map((line, index) => (
                <li key={`${index}-${line}`} className={styles.line}>
                  {line}
                </li>
              ))}
            </ul>
            <p className={styles.sectionLabel}>策略逻辑</p>
            <p className={styles.reasoning}>{state.reply.reasoning}</p>
            {state.reply.warnings.length > 0 && (
              <>
                <p className={styles.sectionLabel}>风险提醒</p>
                <ul className={styles.warnings}>
                  {state.reply.warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`} className={styles.warning}>
                      {warning}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {state.phase === 'unconfigured' && (
          <p className={styles.muted}>本服未开启 AI 发言建议，请联系房主或管理员配置助手服务。</p>
        )}
        {state.phase === 'error' && (
          <>
            <p className={styles.errorText} role="alert">
              {state.message}
            </p>
            <button type="button" className={styles.ask} onClick={request} disabled={disabled}>
              重试
            </button>
          </>
        )}
      </div>
      <p className={styles.recordCount}>已参考 {count} 条此前发言</p>
    </section>
  );
}
