import { useState } from 'react';
import type { FormEvent, JSX } from 'react';

import type { Seat, SpeechMessage } from '../../types';
import styles from './SpeechPanel.module.css';

export interface SpeechPanelProps {
  messages: SpeechMessage[];
  /** Seat currently in their speech slot; null when no speech round is active. */
  speakingSeat: Seat | null;
  /** The viewer's seat; null for spectators. */
  mySeat: Seat | null;
  /** Whether the viewer may post to their slot now. */
  canSpeak: boolean;
  onSend: (text: string) => void;
  disabled?: boolean;
  /** Overrides the default explanation under a locked input. */
  hint?: string;
}

const MAX_SPEECH_LENGTH = 300;

/** Text speech panel: the transcript plus the viewer's own speech input. */
export function SpeechPanel({
  messages,
  speakingSeat,
  mySeat,
  canSpeak,
  onSend,
  disabled = false,
  hint,
}: SpeechPanelProps): JSX.Element {
  const [draft, setDraft] = useState('');

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || disabled || !canSpeak) return;
    onSend(text);
    setDraft('');
  };

  const lockedHint =
    hint ?? (mySeat === null ? '观战视角，无法发言' : canSpeak ? undefined : '轮到他人发言');

  return (
    <section className={styles.panel} aria-label="发言">
      <div className={styles.header}>
        <h3 className={styles.title}>发言</h3>
        {speakingSeat !== null ? (
          <span className={styles.speakingTag}>{speakingSeat}号发言中</span>
        ) : (
          <span className={styles.speakingTagMuted}>发言未开始</span>
        )}
      </div>
      {messages.length === 0 ? (
        <p className={styles.empty}>还没有发言，等待第一位玩家开口</p>
      ) : (
        <ul className={styles.messages}>
          {messages.map((message) => (
            <li
              key={message.id}
              className={[
                styles.message,
                message.seat === speakingSeat && styles.messageSpeaking,
                message.seat === mySeat && styles.messageSelf,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className={styles.messageMeta}>
                {message.seat}号 · {message.name}
              </span>
              <p className={styles.messageText}>{message.text}</p>
            </li>
          ))}
        </ul>
      )}
      <form className={styles.composer} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          value={draft}
          maxLength={MAX_SPEECH_LENGTH}
          disabled={disabled || !canSpeak}
          placeholder={canSpeak ? '说出你的推理…' : '等待中'}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="发言输入"
        />
        <button
          type="submit"
          className={styles.send}
          disabled={disabled || !canSpeak || draft.trim().length === 0}
        >
          发送
        </button>
      </form>
      {lockedHint && !canSpeak ? <p className={styles.hint}>{lockedHint}</p> : null}
    </section>
  );
}
