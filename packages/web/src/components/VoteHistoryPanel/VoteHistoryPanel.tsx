import type { JSX } from 'react';

import { formatVotes } from '../../logic';
import type { VoteRound, VoteRoundOutcome } from '../../types';
import styles from './VoteHistoryPanel.module.css';

export interface VoteHistoryPanelProps {
  /** Every resolved round, in log order — `voteRoundsOf(view.log)`. */
  rounds: VoteRound[];
}

/** Round card title: kind + day, PK revotes labelled by the event's own flag. */
function roundTitle(round: VoteRound): string {
  if (round.kind === 'sheriff') return round.revote ? '警长PK投票' : '警长竞选投票';
  return round.revote ? `第${round.day}天放逐PK投票` : `第${round.day}天放逐投票`;
}

/** Outcome line, matching the copy the day log and vote pad already use. */
function outcomeLine(outcome: VoteRoundOutcome): string {
  switch (outcome.kind) {
    case 'elected':
      return `${outcome.seat}号当选警长`;
    case 'no-sheriff':
      return '警长竞选流产，本局无警长';
    case 'exiled':
      return `${outcome.seat}号被放逐出局`;
    case 'idiot-revealed':
      return `${outcome.seat}号是白痴，失去投票权`;
    case 'blocked-by-idiot':
      return `${outcome.seat}号翻开身份牌：白痴！放逐无效`;
    case 'pk':
      return '平票——进入PK演讲';
    case 'void':
      return '平票——今日无人出局';
  }
}

/**
 * The permanent per-round vote record: every resolved round's full shape —
 * who voted for whom, abstentions, the 1.5 badge ballots — as revealed
 * together at each tally. Public by construction: the tally and its
 * ballots are public events, so players, the dead, and spectators all
 * read the same panel.
 */
export function VoteHistoryPanel({ rounds }: VoteHistoryPanelProps): JSX.Element {
  return (
    <section className={styles.history} aria-label="每轮票形">
      <h3 className={styles.title}>每轮票形</h3>
      {rounds.length === 0 ? (
        <p className={styles.empty}>还没有投票记录</p>
      ) : (
        rounds.map((round, index) => (
          <div key={`${round.kind}-${index}`} className={styles.round}>
            <h4 className={styles.roundTitle}>{roundTitle(round)}</h4>
            <ul className={styles.ballotList}>
              {round.ballots.map((ballot) => (
                <li key={ballot.voter} className={styles.ballot}>
                  <span className={styles.ballotLine}>
                    {ballot.voter}号 → {ballot.target === null ? '弃票' : `${ballot.target}号`}
                  </span>
                  {ballot.weight > 1 && (
                    <span className={styles.badge}>警徽 {formatVotes(ballot.weight)} 票</span>
                  )}
                </li>
              ))}
            </ul>
            <p className={styles.outcome}>{outcomeLine(round.outcome)}</p>
          </div>
        ))
      )}
    </section>
  );
}
