import type { JSX } from 'react';

import styles from './VoiceControls.module.css';

export interface VoiceControlsProps {
  /** True while other seats' live audio is dropped locally. */
  muted: boolean;
  onToggle: () => void;
}

/** Local mute for other seats' live playback — display-only, no frame change. */
export function VoiceControls({ muted, onToggle }: VoiceControlsProps): JSX.Element {
  return (
    <button
      type="button"
      className={`${styles.mute} ${muted ? styles.muteOn : ''}`}
      onClick={onToggle}
      aria-pressed={muted}
      aria-label={muted ? '取消静音' : '静音他人语音'}
    >
      {muted ? '已静音' : '静音语音'}
    </button>
  );
}
