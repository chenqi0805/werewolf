import type { JSX } from 'react';

import type { VoiceSpeechState } from '../../client/voiceSession';
import type { Seat, SpeechMessage } from '../../types';
import styles from './SpeechPanel.module.css';
import { statusCopy } from './statusCopy';

export interface SpeechPanelProps {
  messages: SpeechMessage[];
  /** Seat currently in their speech slot; null when no speech round is active. */
  speakingSeat: Seat | null;
  /** The viewer's seat; null for spectators. */
  mySeat: Seat | null;
  /** Whether the viewer may post to their slot now. */
  canSpeak: boolean;
  disabled?: boolean;
  /** Overrides the default explanation under a locked composer. */
  hint?: string;
  /**
   * This seat's live voice-capture state; null when the viewer is not the
   * current speaker (or the story omits voice). Speech is voice-only — the
   * transcript auto-submits at the slot deadline, so there is nothing to type.
   */
  voice?: VoiceSpeechState | null;
}

/**
 * Speech panel: the public transcript plus the current speaker's voice-only
 * composer — mic status, live zh-CN captions, and the auto-submit schedule.
 * There is no text input: silence passes the slot by design.
 */
export function SpeechPanel({
  messages,
  speakingSeat,
  mySeat,
  canSpeak,
  disabled = false,
  hint,
  voice = null,
}: SpeechPanelProps): JSX.Element {
  const speakingMine = canSpeak && mySeat !== null && !disabled;
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
      {speakingMine ? (
        <div className={styles.composer}>
          <div className={styles.micRow}>
            <span
              className={[styles.micDot, voice?.status === 'recording' && styles.micDotLive]
                .filter(Boolean)
                .join(' ')}
              aria-hidden
            />
            <span className={styles.statusText} role="status">
              {statusCopy(
                voice ?? { status: 'requesting', interimText: '', finalText: '', error: null },
              )}
            </span>
          </div>
          {voice !== null && (voice.finalText.length > 0 || voice.interimText.length > 0) && (
            <p className={styles.captions}>
              {voice.finalText}
              <span className={styles.captionsInterim}>{voice.interimText}</span>
            </p>
          )}
          {voice?.error !== null && voice?.error !== undefined && (
            <p className={styles.error}>{voice.error}</p>
          )}
        </div>
      ) : (
        lockedHint && <p className={styles.hint}>{lockedHint}</p>
      )}
    </section>
  );
}
