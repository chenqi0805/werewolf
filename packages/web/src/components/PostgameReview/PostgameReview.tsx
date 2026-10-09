import { useState } from 'react';
import type { JSX } from 'react';

import type { PostgameReply } from '@werewolf/server';

import { AckError } from '../../client/socketClient';
import { ROLE_META } from '../../roles';
import type { PlayerPostgameStat, WinSide } from '../../types';
import styles from './PostgameReview.module.css';

export interface PostgameReviewProps {
  /** Deterministic per-seat accounting — `postgameStatsOf(view)`. */
  stats: PlayerPostgameStat[];
  /** Which side won — context for the section header. */
  winner: WinSide;
  /** Injected review request; GameOverScreen wires it to `requestPostgameAnalysis(socket)`. */
  onAnalyze: () => Promise<PostgameReply>;
  disabled?: boolean;
}

type PanelState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'review'; reply: PostgameReply }
  | { phase: 'unconfigured' }
  | { phase: 'error'; message: string };

const WINNER_LABEL: Record<WinSide, string> = {
  wolves: '狼人阵营胜利',
  good: '好人阵营胜利',
};

/** Ack codes get player-facing zh copy; anything unknown keeps its code visible. */
const ERROR_LABELS: Record<string, string> = {
  NOT_GAME_OVER: '对局尚未结束。',
  NOT_IN_ROOM: '房间已失效，无法生成复盘。',
  POSTGAME_ERROR: '复盘生成失败，请稍后再试。',
};

function errorTextOf(error: unknown): string {
  if (error instanceof AckError) return ERROR_LABELS[error.code] ?? `复盘出错（${error.code}）`;
  return '网络异常，请稍后再试。';
}

/**
 * The post-game 复盘 section on the game-over screen: the deterministic
 * stats grid is always visible (the whole table sees the same numbers),
 * and the AI block answers one shared generation per room on demand. Pure:
 * the request arrives as an injected promise prop, so stories stub it like
 * `onSend`. 未配置 is a distinct state — the server acks
 * ASSISTANT_UNAVAILABLE when no assistant provider is configured.
 */
export function PostgameReview({
  stats,
  winner,
  onAnalyze,
  disabled = false,
}: PostgameReviewProps): JSX.Element {
  const [state, setState] = useState<PanelState>({ phase: 'idle' });

  const request = (): void => {
    setState({ phase: 'loading' });
    onAnalyze()
      .then((reply) => setState({ phase: 'review', reply }))
      .catch((error: unknown) =>
        setState(
          error instanceof AckError && error.code === 'ASSISTANT_UNAVAILABLE'
            ? { phase: 'unconfigured' }
            : { phase: 'error', message: errorTextOf(error) },
        ),
      );
  };

  const ratings =
    state.phase === 'review' ? [...state.reply.ratings].sort((a, b) => a.seat - b.seat) : [];

  return (
    <section className={styles.review} aria-label="本场复盘">
      <div className={styles.header}>
        <h3 className={styles.title}>本场复盘</h3>
        <span className={styles.winnerTag}>{WINNER_LABEL[winner]}</span>
      </div>

      {stats.length === 0 ? (
        <p className={styles.empty}>暂无对局数据</p>
      ) : (
        <table className={styles.stats} aria-label="全场数据">
          <thead>
            <tr>
              <th scope="col">座位</th>
              <th scope="col">身份</th>
              <th scope="col">发言</th>
              <th scope="col">字数</th>
              <th scope="col">存活</th>
              <th scope="col">得票</th>
              <th scope="col">结局</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat) => {
              const meta = ROLE_META[stat.role];
              return (
                <tr key={stat.seat} className={stat.death === null ? undefined : styles.deadRow}>
                  <td className={styles.seatCell}>{stat.name}</td>
                  <td className={styles.roleCell} data-team={meta.team}>
                    {meta.label}
                  </td>
                  <td>{stat.speeches} 段</td>
                  <td>{stat.speechChars} 字</td>
                  <td>{stat.daysSurvived} 天</td>
                  <td>{stat.votesReceived} 票</td>
                  <td className={styles.fateCell}>{stat.death ?? '存活'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className={styles.aiBlock} aria-live="polite">
        {state.phase === 'idle' && (
          <>
            <p className={styles.note}>
              AI 通读全场发言与票型，给出这局的关键节点和每位玩家的表现评分。
            </p>
            <button type="button" className={styles.ask} onClick={request} disabled={disabled}>
              生成复盘
            </button>
          </>
        )}
        {state.phase === 'loading' && (
          <p className={`${styles.note} ${styles.loading}`}>AI 正在复盘整局对局…</p>
        )}
        {state.phase === 'review' && (
          <>
            <p className={styles.summary}>{state.reply.summary}</p>
            <p className={styles.sectionLabel}>关键节点</p>
            <ul className={styles.moments}>
              {state.reply.keyMoments.map((moment, index) => (
                <li key={`${index}-${moment}`} className={styles.moment}>
                  {moment}
                </li>
              ))}
            </ul>
            <p className={styles.sectionLabel}>玩家评分</p>
            <ul className={styles.ratings}>
              {ratings.map((rating) => {
                const isMvp = rating.seat === state.reply.mvp;
                return (
                  <li
                    key={rating.seat}
                    className={[styles.rating, isMvp ? styles.mvp : ''].filter(Boolean).join(' ')}
                  >
                    <div className={styles.ratingHead}>
                      <span className={styles.ratingSeat}>{rating.seat}号</span>
                      <span className={styles.score}>{rating.score} 分</span>
                      {isMvp && <span className={styles.mvpBadge}>本场最佳</span>}
                    </div>
                    <p className={styles.rationale}>{rating.rationale}</p>
                    <p className={styles.highlight}>高光：{rating.highlight}</p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {state.phase === 'unconfigured' && (
          <p className={styles.muted}>本服未开启 AI 复盘，请联系房主或管理员配置助手服务。</p>
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
    </section>
  );
}
