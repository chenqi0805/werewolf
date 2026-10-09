import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { TimerInfo } from '@werewolf/server';

import { COUNTDOWN_TICK_MS, formatCountdown, msLeftOf } from './gating';

/**
 * Live countdown for the server-armed phase deadline. The client trusts its
 * own clock against `endsAt` — correct for a same-host deployment; clock
 * offset calibration is a follow-up for cross-host deployments.
 */
export function Countdown({ timer }: { timer: TimerInfo | null }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const left = msLeftOf(timer, now);
  if (left === null) return null;
  const urgent = left <= 10_000;
  return (
    <span
      className={`scr-countdown${urgent ? ' scr-countdown--urgent' : ''}`}
      role="timer"
      aria-label="剩余时间"
    >
      {formatCountdown(left)}
    </span>
  );
}
