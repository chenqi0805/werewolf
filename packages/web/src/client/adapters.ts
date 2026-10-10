import type { BoardId, GameEvent, Seat } from '@werewolf/engine';

import { boardOptionOf } from '../boardOptions';
import type { PlayerRow, PlayerView, StepView, YouView } from '@werewolf/server';

import type {
  LogEntry,
  LogKind,
  PlayerPostgameStat,
  PlayerReveal,
  SeatView,
  SeerResult,
  SpeechContext,
  SpeechMessage,
  SpeechRecord,
  VoteRound,
  VoteRoundOutcome,
  VoteTally,
} from '../types';

/** Label for a seat, everywhere in the UI. */
export function seatLabel(seat: Seat): string {
  return `${seat}号`;
}

/** Renderable name for a player row: chosen name, bot nickname, then the seat label. */
export function rowLabelOf(row: PlayerRow): string {
  return row.name || row.botName || seatLabel(row.seat);
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
    name: rowLabelOf(row),
    alive: row.alive,
    isSelf: row.seat === view.you.seat,
    isSheriff: row.hasBadge,
    isSpeaking: speaking === row.seat,
    occupied: row.occupied,
    isBot: row.isBot || undefined,
    role: row.role === null ? undefined : row.role,
    revealedIdiot: row.revealedIdiot || undefined,
  }));
}

/** Alive seats other than the viewer — witch poison / hunter shot candidates. */
export function livingOthersOf(view: PlayerView): SeatView[] {
  const you = view.you.seat;
  return seatViewsOf(view).filter((s) => s.alive && s.seat !== you);
}

/** Seats with a session holding them — the lobby's true count, not alive rows. */
export function occupiedCountOf(seats: readonly SeatView[]): number {
  return seats.filter((s) => s.occupied === true).length;
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
  return ![
    'WOLF_KILL_VOTE',
    'EXILE_VOTE_CAST',
    'SHERIFF_VOTE_CAST',
    'DEATH_RESOLVED',
    'SPEECH_MADE',
  ].includes(event.type);
}

function logText(event: GameEvent): string | null {
  switch (event.type) {
    case 'GAME_STARTED':
      // Fallback only — callers pass the view's board so the line names the
      // actual deal (gameStartText).
      return '游戏开始：12人标准局（4狼·4民·预言家·女巫·猎人·白痴）';
    case 'WHITE_WOLF_KING_DESTRUCTED':
      return `${seatLabel(event.actor)}自爆，带走了${seatLabel(event.target)}`;
    case 'WOLF_EXPLODED':
      return `${seatLabel(event.seat)}自爆，白天结束`;
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
    case 'WHITE_WOLF_KING_DESTRUCTED':
    case 'WOLF_EXPLODED':
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
export function logToEntries(log: readonly GameEvent[], board?: BoardId): LogEntry[] {
  let day = 1;
  const entries: LogEntry[] = [];
  log.forEach((event, index) => {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      day = event.dayNumber;
    }
    if (!isLoggedEvent(event)) return;
    const text =
      event.type === 'GAME_STARTED' && board !== undefined ? gameStartText(board) : logText(event);
    if (text === null) return;
    entries.push({ id: `log-${index}`, day, kind: logKind(event), text });
  });
  return entries;
}

/** The opening log line names the board actually dealt, from the registry. */
function gameStartText(board: BoardId): string {
  const option = boardOptionOf(board);
  return `游戏开始：${option.name}（${option.lineup}）`;
}

/** One accepted speech pinned to its day — the shared walk behind both transcript adapters. */
interface DatedSpeech {
  day: number;
  context: SpeechContext;
  seat: Seat;
  text: string;
}

/**
 * Every SPEECH_MADE event with its game day. The day walks forward on
 * NIGHT_BEGAN / DAY_BROKE exactly as `logToEntries` does; the server has
 * already filtered the list to what this viewer may see.
 */
function datedSpeechOf(log: readonly GameEvent[]): DatedSpeech[] {
  const speeches: DatedSpeech[] = [];
  let day = 1;
  log.forEach((event) => {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      day = event.dayNumber;
    }
    if (event.type !== 'SPEECH_MADE') return;
    speeches.push({ day, context: event.context, seat: event.seat, text: event.text });
  });
  return speeches;
}

/** seat → renderable name for every seated row, resolved once per view. */
function namesOf(view: PlayerView): Map<Seat, string> {
  return new Map(view.players.map((row) => [row.seat, rowLabelOf(row)]));
}

/** Every SPEECH_MADE event as a transcript row, in log order. */
export function speechMessagesOf(view: PlayerView): SpeechMessage[] {
  const names = namesOf(view);
  return datedSpeechOf(view.log).map((speech, index) => ({
    id: `sp-${index}`,
    seat: speech.seat,
    name: names.get(speech.seat) ?? seatLabel(speech.seat),
    text: speech.text,
  }));
}

/**
 * The permanent speech record, grouped by game day — days ascending,
 * within-day log order preserved. Speech never appears in DayLog, so this
 * feeds the dedicated SpeechHistory panel instead.
 */
export function speechByDayOf(view: PlayerView): Array<{ day: number; records: SpeechRecord[] }> {
  const names = namesOf(view);
  const byDay = new Map<number, SpeechRecord[]>();
  for (const speech of datedSpeechOf(view.log)) {
    const bucket = byDay.get(speech.day);
    const record: SpeechRecord = {
      day: speech.day,
      context: speech.context,
      seat: speech.seat,
      name: names.get(speech.seat) ?? seatLabel(speech.seat),
      text: speech.text,
    };
    if (bucket) bucket.push(record);
    else byDay.set(speech.day, [record]);
  }
  return [...byDay.entries()].sort(([a], [b]) => a - b).map(([day, records]) => ({ day, records }));
}

/**
 * The latest exile tally plus its outcome, reconstructed from the public
 * log (counts and the full ballot reveal ride VOTE_TALLY; the exile event
 * follows). Returns null until the first exile vote resolves.
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
        voterSeats: event.ballots
          .filter((ballot) =>
            count.seat === null ? ballot.target === null : ballot.target === count.seat,
          )
          .map((ballot) => ballot.voter),
        votes: count.votes,
      })),
      abstainers: event.ballots
        .filter((ballot) => ballot.target === null)
        .map((ballot) => ballot.voter),
      exiled: voided ? null : exiled,
      voided,
    };
  }
  return null;
}

/** How a resolved round ends: the round-closing event after its tally, before the next same-kind tally. */
function voteOutcomeOf(
  log: readonly GameEvent[],
  from: number,
  kind: 'sheriff' | 'exile',
  revote: boolean,
): VoteRoundOutcome {
  for (let index = from + 1; index < log.length; index += 1) {
    const event = log[index];
    if (event === undefined) break;
    // The next same-kind tally is this round's PK revote — unless this
    // round already was the revote, in which case reaching it means the
    // revote tied and the day voided (no outcome event exists).
    if (event.type === 'VOTE_TALLY' && event.kind === kind) {
      return revote ? { kind: 'void' } : { kind: 'pk' };
    }
    switch (event.type) {
      case 'SHERIFF_ELECTED':
        return { kind: 'elected', seat: event.seat };
      case 'NO_SHERIFF':
        return { kind: 'no-sheriff' };
      case 'PLAYER_EXILED':
        return { kind: 'exiled', seat: event.seat };
      case 'IDIOT_REVEALED':
        return { kind: 'idiot-revealed', seat: event.seat };
      case 'EXILE_BLOCKED_BY_IDIOT':
        return { kind: 'blocked-by-idiot', seat: event.seat };
      default:
        break;
    }
  }
  return revote ? { kind: 'void' } : { kind: 'pk' };
}

/**
 * Every resolved vote round, in log order, walked once off the public log
 * — the adapter behind the 每轮票形 history. Same day walk as
 * `datedSpeechOf`; the server has already filtered the list to what this
 * viewer may see, so alive, dead, and spectator seats derive identical
 * rounds (the tally and its ballots are public).
 */
export function voteRoundsOf(log: readonly GameEvent[]): VoteRound[] {
  const rounds: VoteRound[] = [];
  let day = 1;
  log.forEach((event, index) => {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      day = event.dayNumber;
      return;
    }
    if (event.type !== 'VOTE_TALLY') return;
    rounds.push({
      kind: event.kind,
      day,
      revote: event.revote,
      counts: event.counts,
      ballots: event.ballots,
      outcome: voteOutcomeOf(log, index, event.kind, event.revote),
    });
  });
  return rounds;
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

/** Public death markers the client log carries — exact causes (刀 vs 毒) live in server-only events. */
type PublicDeathCause = 'night' | 'exile' | 'shot' | 'destruct' | 'self-destruct';

function deathTextOf(death: { day: number; cause: PublicDeathCause }): string {
  const { cause, day } = death;
  switch (cause) {
    case 'night':
      return day === 1 ? '首夜出局' : `第${day}夜出局`;
    case 'exile':
      return `第${day}天放逐`;
    case 'shot':
      return `第${day}天被枪带走`;
    case 'destruct':
      return `第${day}天被自爆带走`;
    case 'self-destruct':
      return `第${day}天自爆出局`;
  }
}

/**
 * The deterministic per-seat 复盘 stats, walked once off the view's log plus
 * the game-over reveal rows. The client log never carries server-only
 * events (individual ballot casts, exact night-death causes), so this
 * states only what the table saw: votes cast come from the public ballot
 * reveals, votes received from the public tallies, and night deaths read
 * 出局 rather than claiming a cause.
 */
export function postgameStatsOf(view: PlayerView): PlayerPostgameStat[] {
  const stats = new Map<Seat, PlayerPostgameStat>();
  for (const row of view.players) {
    if (row.role === null) continue;
    stats.set(row.seat, {
      seat: row.seat,
      name: seatLabel(row.seat),
      role: row.role,
      speeches: 0,
      speechChars: 0,
      daysSurvived: view.dayNumber,
      votesCast: 0,
      votesReceived: 0,
      death: null,
    });
  }
  let day = 1;
  const deaths = new Map<Seat, { day: number; cause: PublicDeathCause }>();
  for (const event of view.log) {
    if (event.type === 'NIGHT_BEGAN' || event.type === 'DAY_BROKE') {
      day = event.dayNumber;
      continue;
    }
    switch (event.type) {
      case 'SPEECH_MADE': {
        const stat = stats.get(event.seat);
        if (stat) {
          stat.speeches += 1;
          stat.speechChars += event.text.length;
        }
        break;
      }
      case 'DEATH_ANNOUNCED':
        if (!deaths.has(event.seat)) deaths.set(event.seat, { day, cause: 'night' });
        break;
      case 'PLAYER_EXILED':
        if (!deaths.has(event.seat)) deaths.set(event.seat, { day, cause: 'exile' });
        break;
      case 'HUNTER_SHOT':
        if (!deaths.has(event.target)) deaths.set(event.target, { day, cause: 'shot' });
        break;
      case 'WHITE_WOLF_KING_DESTRUCTED':
        if (!deaths.has(event.actor)) deaths.set(event.actor, { day, cause: 'self-destruct' });
        if (!deaths.has(event.target)) deaths.set(event.target, { day, cause: 'destruct' });
        break;
      case 'VOTE_TALLY': {
        for (const ballot of event.ballots) {
          const voter = stats.get(ballot.voter);
          if (voter) voter.votesCast += 1;
        }
        if (event.kind !== 'exile') break;
        for (const count of event.counts) {
          if (count.seat === null) continue;
          const stat = stats.get(count.seat);
          if (stat) stat.votesReceived += count.votes;
        }
        break;
      }
      default:
        break;
    }
  }
  for (const [seat, death] of deaths) {
    const stat = stats.get(seat);
    if (!stat) continue;
    stat.death = deathTextOf(death);
    stat.daysSurvived = Math.max(death.day - 1, 0);
  }
  return [...stats.values()].sort((a, b) => a.seat - b.seat);
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

const ROOM_ERROR_TEXT: Record<string, string> = {
  ROOM_NOT_FOUND: '房间不存在或已关闭',
  ROOM_FULL: '房间已满员',
  ROOM_NOT_FULL: '人数未满，无法开局',
  ALREADY_STARTED: '对局已经开始',
  GAME_RUNNING: '对局进行中，无法加入',
  BAD_TOKEN: '会话已失效，请重新加入',
  NOT_IN_ROOM: '你已不在房间中',
  NO_SEAT: '你没有座位',
  NOT_A_BOT: '该座位不是AI玩家',
  BOTS_UNAVAILABLE: 'AI玩家暂不可用',
};

/** Short zh label for a known room error code; unknown codes pass through. */
export function roomErrorText(code: string): string {
  return ROOM_ERROR_TEXT[code] ?? `操作失败（${code}）`;
}
