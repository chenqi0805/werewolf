import { useState } from 'react';
import type { JSX } from 'react';

import { formatVotes, seatsLabel } from '../../logic';
import type { Seat, SeatView, VoteTally } from '../../types';
import { SeatPicker } from '../SeatPicker/SeatPicker';
import styles from './VotePad.module.css';

/**
 * Discriminated union: a vote pad either collects a vote or shows the resolved
 * tally — never both, and the tally shape is only required in tally mode.
 */
export type VotePadProps =
  | {
      mode: 'vote';
      /** Living candidates for exile. */
      candidates: SeatView[];
      /** Whether the viewer holds vote rights at all. */
      canVote: boolean;
      /** Why the viewer cannot vote — shown when canVote is false. */
      voteBlockNote?: string;
      isSheriff?: boolean;
      /** Confirmed exile target; null commits 弃票 (abstain). */
      onSubmitVote: (target: Seat | null) => void;
      disabled?: boolean;
    }
  | {
      mode: 'tally';
      tally: VoteTally;
    };

/** Exile vote pad: cast a vote, abstain, or inspect the resolved tally. */
export function VotePad(props: VotePadProps): JSX.Element {
  if (props.mode === 'tally') {
    return <TallyView tally={props.tally} />;
  }
  return <VoteView {...props} />;
}

function VoteView({
  candidates,
  canVote,
  voteBlockNote,
  isSheriff = false,
  onSubmitVote,
  disabled = false,
}: Extract<VotePadProps, { mode: 'vote' }>): JSX.Element {
  const [selected, setSelected] = useState<Seat | null>(null);

  if (!canVote) {
    return (
      <section className={styles.pad} aria-label="放逐投票">
        <h3 className={styles.title}>放逐投票</h3>
        <p className={styles.blockNote}>{voteBlockNote ?? '你当前没有投票权'}</p>
      </section>
    );
  }

  return (
    <section className={styles.pad} aria-label="放逐投票">
      <h3 className={styles.title}>放逐投票</h3>
      {isSheriff ? <p className={styles.sheriffNote}>你持有警徽，此票计 1.5 票</p> : null}
      <SeatPicker
        options={candidates}
        selected={selected}
        onSelect={setSelected}
        disabled={disabled}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.abstain}`}
          disabled={disabled}
          onClick={() => onSubmitVote(null)}
        >
          弃票
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={disabled || selected === null}
          onClick={() => selected !== null && onSubmitVote(selected)}
        >
          {selected === null ? '确认放逐目标' : `放逐 ${selected}号`}
        </button>
      </div>
    </section>
  );
}

function TallyView({ tally }: { tally: VoteTally }): JSX.Element {
  const sorted = [...tally.rows].sort((a, b) => b.votes - a.votes);
  return (
    <section className={styles.pad} aria-label="投票结果">
      <h3 className={styles.title}>投票结果</h3>
      {tally.voided ? <p className={styles.voidNote}>平票——今日无人出局</p> : null}
      <ul className={styles.tallyRows}>
        {sorted.map((row) => (
          <li
            key={row.target ?? 'abstain'}
            className={[
              styles.tallyRow,
              !tally.voided && row.target === tally.exiled && styles.exiled,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className={styles.tallyTarget}>
              {row.target === null ? '弃票' : `${row.target}号`}
            </span>
            <span className={styles.tallyVotes}>{formatVotes(row.votes)} 票</span>
            <span className={styles.tallyVoters}>{seatsLabel(row.voterSeats)}</span>
          </li>
        ))}
      </ul>
      {tally.abstainers.length > 0 ? (
        <p className={styles.abstainers}>弃票：{seatsLabel(tally.abstainers)}</p>
      ) : null}
      {!tally.voided && tally.exiled !== null ? (
        <p className={styles.exiledNote}>{tally.exiled}号被放逐出局</p>
      ) : null}
    </section>
  );
}
