import type { GameEvent, Seat } from '@werewolf/engine';
import type { PlayerView, StepView, YouView } from '@werewolf/server';

import type {
  LogEntry,
  LogKind,
  PlayerReveal,
  SeatView,
  SeerResult,
  SpeechMessage,
  VoteTally,
} from '../types';

/** Label for a seat, everywhere in the UI. */
export function seatLabel(seat: Seat): string {
  return `${seat}号`;
}

/** The four speech contexts share one cursor read. */
export function speakingSeatOf(step: StepView): Seat | null {
  switch (step.kind) {
    case 'speech':
      return step.order !== null ? (step.order[step.cursor] ?? null) : null;
    case 'last-words':
    case 'sheriff-speech':
      return step.queue[step.cursor] ?? null;
    case 'pk-speech':
      return step.tied[step.cursor] ?? null;
    default:
      return null;
  }
}

/** Rows → the grid's SeatViews, with self/sheriff/speaking flags resolved. */
export function seatViewsOf(view: PlayerView): SeatView[] {
  const speaking = speakingSeatOf(view.step);
  return view.players.map((row) => ({
    seat: row.seat,
    name: seatLabel(row.seat),
    alive: row.alive,
    isSelf: row.seat === view.you.seat,
    isSheriff: row.hasBadge,
    isSpeaking: speaking === row.seat,
    role: row.role === null ? undefined : row.role,
    revealedIdiot: row.revealedIdiot || undefined,
  }));
}

/** Alive seats other than the viewer — witch poison / hunter shot candidates. */
export function livingOthersOf(view: PlayerView): SeatView[] {
  const you = view.you.seat;
  return seatViewsOf(view).filter((s) => s.alive && s.seat !== you);
}

/** The wolf pack's viable victims: living and not wolves. */
export function wolfTargetsOf(view: PlayerView): SeatView[] {
  const pack = new Set(view.you.wolfPack ?? []);
  return seatViewsOf(view).filter((s) => s.alive && !pack.has(s.seat));
}

/** Seer candidates: living, not self, not yet checked. */
export function uncheckedTargetsOf(view: PlayerView): SeatView[] {
  const checked = view.you.seerChecks ?? {};
  const you = view.you.seat;
  return seatViewsOf(view).filter((s) => s.alive && s.seat !== you && !(s.seat in checked));
}

/** The seer's private check history, in seat order. */
export function seerResultsOf(you: YouView): SeerResult[] {
  return Object.entries(you.seerChecks ?? {})
    .map(([seat, camp]) => ({ seat: Number(seat), isWolf: camp === 'wolf' }))
    .sort((a, b) => a.seat - b.seat);
}

/** Silent in the day log — private chatter or summarized elsewhere. */
function isLoggedEvent(event: GameEvent): boolean {
  return !['WOLF_KILL_VOTE', 'EXILE_VOTE_CAST', 'SHERIFF_VOTE_CAST', 'DEATH_RESOLVED', 'SPEECH_MADE'].includes(
    event.type,
  );
}

function logText(event: GameEvent): string | null {
  switch (event.type) {
    case 'GAME_STARTED':
      return '游戏开始：12人标准局（4狼·4民·预言家·女巫·猎人·白痴）';
    case 'NIGHT_BEGAN':
      return `第 ${event.dayNumber} 夜来临`;
    case 'DAY_BROKE':
      return '天亮了';
    case 'PEACEFUL_NIGHT':
      return '平安夜';
    case 'DEATH_ANNOUNCED':
      return `${seatLabel(event.seat)}昨晚出局`;
    case 'KILL_TARGET_SET':
      return event.target === null ? '狼队选择了空刀' : `狼队选择了${seatLabel(event.target)}`;
    case 'WITCH_HEALED':
      return `女巫用解药救了${seatLabel(event.target)}`;
    case 'WITCH_POISONED':
      return `女巫毒了${seatLabel(event.target)}`;
    case 'WITCH_PASSED':
      return '女巫选择跳过';
    case 'SEER_CHECKED':
      return `查验${seatLabel(event.target)}：${event.result === 'wolf' ? '狼人' : '好人'}`;
    case 'SEER_PASSED':
      return '预言家选择跳过';
    case 'SHERIFF_SIGNUP_MADE':
      return `${seatLabel(event.seat)}上警`;
    case 'SHERIFF_WITHDREW':
      return `${seatLabel(event.seat)}退水`;
    case 'SHERIFF_ELECTED':
      return `${seatLabel(event.seat)}当选警长`;
    case 'NO_SHERIFF':
      return '警长竞选流产，本局无警长';
    case 'VOTE_TALLY':
      return event.kind === 'sheriff' ? '警长竞选开票' : '放逐投票开票';
    case 'SPEECH_ORDER_SET': {
      const first = event.order[0];
      if (first === undefined) return '发言顺序已确定';
      return `发言从${seatLabel(first)}号开始（${event.direction === 'cw' ? '顺时针' : '逆时针'}）`;
    }
    case 'PLAYER_EXILED':
      return `${seatLabel(event.seat)}被放逐出局`;
    case 'IDIOT_REVEALED':
      return `${seatLabel(event.seat)}是白痴，失去投票权`;
    case 'EXILE_BLOCKED_BY_IDIOT':
      return `${seatLabel(event.seat)}翻开身份牌：白痴！放逐无效`;
    case 'HUNTER_SHOT':
      return `${seatLabel(event.shooter)}猎人开枪带走了${seatLabel(event.target)}`;
    case 'HUNTER_PASSED':
      return `${seatLabel(event.shooter)}猎人放弃开枪`;
    case 'BADGE_PASSED':
      return `${seatLabel(event.from)}将警徽移交给${seatLabel(event.to)}`;
    case 'BADGE_DESTROYED':
      return `${seatLabel(event.from)}撕毁了警徽`;
    case 'GAME_OVER':
      return event.winner === 'wolves' ? '狼人阵营胜利' : '好人阵营胜利';
    default:
      return null;
  }
}

function logKind(event: GameEvent): LogKind {
  switch (event.type) {
    case 'DEATH_ANNOUNCED':
    case 'PLAYER_EXILED':
    case 'HUNTER_SHOT':
      return 'death';
    case 'VOTE_TALLY':
      return 'vote';
    case 'SHERIFF_SIGNUP_MADE':
    case 'SHERIFF_WITHDREW':
    case 'SHERIFF_ELECTED':
    case 'NO_SHERIFF':
    case 'BADGE_PASSED':
    case 'BADGE_DESTROYED':
      return 'sheriff';
    case 'IDIOT_REVEALED':
    case 'EXILE_BLOCKED_BY_IDIOT':
    case 'GAME_OVER':
      return 'reveal';
    default:
      return 'system';
  }
}

/**
 * Visible events → day-grouped log entries. The day walks forward on
 * NIGHT_BEGAN / DAY_BROKE; the server has already filtered the list to
 * what this viewer may see.
 */
export function logToEntries(log: readonly GameEvent[]): LogEntry[] {
  let day = 1;
  const entries: LogEntry[] = [];
  log.forEach((event, index) => {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      day = event.dayNumber;
    }
    if (!isLoggedEvent(event)) return;
    const text = logText(event);
    if (text === null) return;
    entries.push({ id: `log-${index}`, day, kind: logKind(event), text });
  });
  return entries;
}

/** Every SPEECH_MADE event as a transcript row, in log order. */
export function speechMessagesOf(log: readonly GameEvent[]): SpeechMessage[] {
  const messages: SpeechMessage[] = [];
  let count = 0;
  for (const event of log) {
    if (event.type !== 'SPEECH_MADE') continue;
    messages.push({
      id: `sp-${count}`,
      seat: event.seat,
      name: seatLabel(event.seat),
      text: event.text,
    });
    count += 1;
  }
  return messages;
}

/**
 * The latest exile tally plus its outcome, reconstructed from the public
 * log (the protocol carries counts, then the exile event — never voters).
 * Returns null until the first exile vote resolves.
 */
export function deriveTally(log: readonly GameEvent[]): VoteTally | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index];
    if (event === undefined || event.type !== 'VOTE_TALLY' || event.kind !== 'exile') continue;
    let exiled: Seat | null = null;
    let voided = false;
    for (const later of log.slice(index + 1)) {
      if (later.type === 'PLAYER_EXILED') exiled = later.seat;
      if (later.type === 'EXILE_BLOCKED_BY_IDIOT') voided = true;
    }
    return {
      rows: event.counts.map((count) => ({
        target: count.seat,
        voterSeats: [],
        votes: count.votes,
      })),
      abstainers: [],
      exiled: voided ? null : exiled,
      voided,
    };
  }
  return null;
}

/** Full reveal rows for the game-over screen. */
export function revealsOf(view: PlayerView): PlayerReveal[] {
  return view.players.flatMap((row) =>
    row.role === null
      ? []
      : [{ seat: row.seat, role: row.role, alive: row.alive, hasBadge: row.hasBadge }],
  );
}

export function winSideOf(view: PlayerView): 'wolves' | 'good' {
  return view.winner ?? 'good';
}

const STEP_CAPTIONS: Record<StepView['kind'], string> = {
  lobby: '等待加入',
  night: '夜晚行动',
  'sheriff-signup': '警长竞选报名',
  'sheriff-speech': '警长竞选演讲',
  'sheriff-vote': '警长投票',
  'dawn-announce': '公布死讯',
  'last-words': '遗言',
  speech: '发言中',
  'exile-vote': '放逐投票',
  'pk-speech': 'PK演讲',
  'pk-vote': 'PK投票',
  'hunter-shot': '猎人开枪',
  'badge-pass': '警徽移交',
  'game-over': '对局结束',
};

/** Short caption for the current step, e.g. for the room header. */
export function phaseCaptionOf(view: PlayerView): string {
  const base = STEP_CAPTIONS[view.step.kind];
  if (view.step.kind === 'night') {
    const who = { wolf: '狼人行动', witch: '女巫行动', seer: '预言家行动' }[view.step.step];
    return `夜晚 · ${who}`;
  }
  return base;
}

/** True while the viewer is a real seated player (not a spectator). */
export function isSeated(view: PlayerView): view is PlayerView & { you: YouView & { seat: Seat } } {
  return view.you.seat !== null;
}
