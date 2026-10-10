import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/engine';
import type { PlayerView, YouView } from '@werewolf/server';

import {
  deriveTally,
  logToEntries,
  occupiedCountOf,
  phaseCaptionOf,
  postgameStatsOf,
  revealsOf,
  roomErrorText,
  seerResultsOf,
  seatViewsOf,
  speechByDayOf,
  speechMessagesOf,
  speakingSeatOf,
  winSideOf,
} from './adapters';

const you = (overrides: Partial<YouView> = {}): YouView => ({
  seat: 3,
  role: null,
  alive: true,
  hasBadge: false,
  revealedIdiot: false,
  voteWeight: 1,
  ...overrides,
});

const view = (overrides: Partial<PlayerView> = {}): PlayerView => ({
  phase: 'lobby',
  dayNumber: 0,
  winner: null,
  board: 'classic',
  you: you(),
  players: [],
  step: { kind: 'lobby' },
  log: [],
  timer: null,
  ...overrides,
});

const row = (seat: number, overrides: Partial<PlayerView['players'][number]> = {}) => ({
  seat,
  name: '',
  alive: true,
  hasBadge: false,
  revealedIdiot: false,
  voteWeight: 1,
  role: null,
  occupied: true,
  isBot: false,
  botName: null,
  ...overrides,
});

describe('seatViewsOf', () => {
  it('maps rows onto SeatViews with self and sheriff flags', () => {
    const v = view({
      you: you({ seat: 3, role: 'witch', hasBadge: false }),
      players: [
        row(1),
        row(3, { role: 'witch' }),
        row(7, { hasBadge: true, alive: false }),
        row(9, { revealedIdiot: true, role: 'idiot' }),
      ],
      step: { kind: 'speech', order: [3, 7, 9], cursor: 1 },
    });
    const seats = seatViewsOf(v);
    expect(seats.find((s) => s.seat === 3)).toMatchObject({ isSelf: true, role: 'witch' });
    expect(seats.find((s) => s.seat === 7)).toMatchObject({
      isSheriff: true,
      alive: false,
      isSpeaking: true,
    });
    expect(seats.find((s) => s.seat === 9)).toMatchObject({ revealedIdiot: true, role: 'idiot' });
    expect(seats.find((s) => s.seat === 1)).toMatchObject({
      isSelf: false,
      role: undefined,
      isSpeaking: false,
    });
  });
});

describe('speakingSeatOf', () => {
  it('reads the cursor across the four speech contexts', () => {
    expect(speakingSeatOf({ kind: 'speech', order: [5, 6], cursor: 1 })).toBe(6);
    expect(speakingSeatOf({ kind: 'speech', order: null, cursor: 0 })).toBeNull();
    expect(speakingSeatOf({ kind: 'last-words', queue: [8], cursor: 0 })).toBe(8);
    expect(speakingSeatOf({ kind: 'sheriff-speech', queue: [2, 4], cursor: 0 })).toBe(2);
    expect(speakingSeatOf({ kind: 'pk-speech', tied: [5, 9], cursor: 1 })).toBe(9);
    expect(speakingSeatOf({ kind: 'night', step: 'wolf' })).toBeNull();
  });
});

describe('logToEntries', () => {
  it('attributes entries to the current day and renders Chinese text', () => {
    const log: GameEvent[] = [
      { type: 'NIGHT_BEGAN', dayNumber: 1 },
      { type: 'PEACEFUL_NIGHT' },
      { type: 'DAY_BROKE', dayNumber: 1 },
      { type: 'SHERIFF_ELECTED', seat: 3 },
      { type: 'PLAYER_EXILED', seat: 7 },
      { type: 'IDIOT_REVEALED', seat: 9 },
      { type: 'HUNTER_SHOT', shooter: 7, target: 2 },
      { type: 'BADGE_PASSED', from: 3, to: 5 },
      { type: 'BADGE_DESTROYED', from: 5 },
      { type: 'GAME_OVER', winner: 'wolves' },
    ];
    const entries = logToEntries(log);
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ['system', '第 1 夜来临'],
      ['system', '平安夜'],
      ['system', '天亮了'],
      ['sheriff', '3号当选警长'],
      ['death', '7号被放逐出局'],
      ['reveal', '9号是白痴，失去投票权'],
      ['death', '7号猎人开枪带走了2号'],
      ['sheriff', '3号将警徽移交给5号'],
      ['sheriff', '5号撕毁了警徽'],
      ['reveal', '狼人阵营胜利'],
    ]);
    // Day attribution: everything after DAY_BROKE day 1 belongs to day 1.
    const exiled = entries.find((e) => e.text.includes('放逐出局'));
    expect(exiled?.day).toBe(1);
  });

  it('logs a plain-wolf explode as a death line in the king-destruct style', () => {
    const log: GameEvent[] = [
      { type: 'NIGHT_BEGAN', dayNumber: 1 },
      { type: 'DAY_BROKE', dayNumber: 1 },
      { type: 'WOLF_EXPLODED', seat: 9 },
    ];
    expect(logToEntries(log).map((e) => [e.kind, e.text])).toEqual([
      ['system', '第 1 夜来临'],
      ['system', '天亮了'],
      ['death', '9号自爆，白天结束'],
    ]);
  });

  it('renders death announcements on their night', () => {
    const log: GameEvent[] = [
      { type: 'NIGHT_BEGAN', dayNumber: 2 },
      { type: 'DEATH_ANNOUNCED', seat: 4 },
      { type: 'DAY_BROKE', dayNumber: 2 },
    ];
    const entries = logToEntries(log);
    expect(entries[1]).toMatchObject({ day: 2, kind: 'death', text: '4号昨晚出局' });
  });
});

describe('speechMessagesOf', () => {
  it('collects every SPEECH_MADE event as transcript rows', () => {
    const log: GameEvent[] = [
      { type: 'SPEECH_MADE', seat: 3, text: '过', context: 'sheriff-speech' },
      { type: 'SPEECH_ORDER_SET', direction: 'cw', order: [3, 4] },
      { type: 'SPEECH_MADE', seat: 5, text: '我是预言家', context: 'speech' },
    ];
    const messages = speechMessagesOf(view({ log }));
    expect(messages).toEqual([
      { id: 'sp-0', seat: 3, name: '3号', text: '过' },
      { id: 'sp-1', seat: 5, name: '5号', text: '我是预言家' },
    ]);
  });

  it('resolves transcript names from the view rows, falling back to the label', () => {
    const v = view({
      players: [row(3, { name: '阿明' }), row(5, { botName: '夜行者' })],
      log: [
        { type: 'SPEECH_MADE', seat: 3, text: '我是预言家', context: 'speech' },
        { type: 'SPEECH_MADE', seat: 5, text: '过', context: 'speech' },
        { type: 'SPEECH_MADE', seat: 6, text: '查杀7号', context: 'speech' },
      ],
    });
    expect(speechMessagesOf(v).map((m) => m.name)).toEqual(['阿明', '夜行者', '6号']);
  });
});

describe('speechByDayOf', () => {
  // Sheriff election on day 1, then two full day cycles of speeches.
  const multiDayLog: GameEvent[] = [
    { type: 'GAME_STARTED' },
    { type: 'DAY_BROKE', dayNumber: 1 },
    { type: 'SPEECH_MADE', seat: 3, text: '竞选发言', context: 'sheriff-speech' },
    { type: 'SHERIFF_ELECTED', seat: 3 },
    { type: 'NIGHT_BEGAN', dayNumber: 1 },
    { type: 'DAY_BROKE', dayNumber: 1 },
    { type: 'DEATH_ANNOUNCED', seat: 2 },
    { type: 'SPEECH_MADE', seat: 2, text: '遗言内容', context: 'last-words' },
    { type: 'SPEECH_MADE', seat: 5, text: '我是预言家', context: 'speech' },
    { type: 'PLAYER_EXILED', seat: 7 },
    { type: 'NIGHT_BEGAN', dayNumber: 2 },
    { type: 'DAY_BROKE', dayNumber: 2 },
    { type: 'SPEECH_MADE', seat: 9, text: '第二天发言', context: 'speech' },
    { type: 'SPEECH_MADE', seat: 5, text: 'PK发言', context: 'pk-speech' },
    { type: 'SPEECH_MADE', seat: 7, text: 'PK对峙', context: 'pk-speech' },
  ];

  it('attributes speeches to the right day across all four contexts', () => {
    const groups = speechByDayOf(view({ log: multiDayLog }));
    expect(groups).toHaveLength(2);
    expect(groups[0]?.day).toBe(1);
    expect(groups[0]?.records.map((r) => [r.context, r.seat, r.day])).toEqual([
      ['sheriff-speech', 3, 1],
      ['last-words', 2, 1],
      ['speech', 5, 1],
    ]);
    expect(groups[1]?.day).toBe(2);
    expect(groups[1]?.records.map((r) => [r.context, r.seat, r.day])).toEqual([
      ['speech', 9, 2],
      ['pk-speech', 5, 2],
      ['pk-speech', 7, 2],
    ]);
    expect(groups[1]?.records[0]).toMatchObject({ name: '9号', text: '第二天发言' });
  });

  it('resolves record names from the view rows', () => {
    const v = view({ players: [row(5, { name: '阿明' })], log: multiDayLog });
    const flat = speechByDayOf(v).flatMap((group) => group.records);
    expect(flat.filter((r) => r.seat === 5).map((r) => r.name)).toEqual(['阿明', '阿明']);
  });

  it('captures every SPEECH_MADE exactly once, in log order', () => {
    const flat = speechByDayOf(view({ log: multiDayLog })).flatMap((group) => group.records);
    expect(flat.map((r) => r.text)).toEqual([
      '竞选发言',
      '遗言内容',
      '我是预言家',
      '第二天发言',
      'PK发言',
      'PK对峙',
    ]);
  });

  it('re-pins the day on NIGHT_BEGAN alone, matching logToEntries', () => {
    const log: GameEvent[] = [
      { type: 'DAY_BROKE', dayNumber: 1 },
      { type: 'SPEECH_MADE', seat: 4, text: '第一天发言', context: 'speech' },
      { type: 'NIGHT_BEGAN', dayNumber: 2 },
      { type: 'DAY_BROKE', dayNumber: 2 },
      { type: 'SPEECH_MADE', seat: 4, text: '第二天发言', context: 'speech' },
    ];
    const groups = speechByDayOf(view({ log }));
    expect(groups.map((g) => [g.day, g.records[0]?.text])).toEqual([
      [1, '第一天发言'],
      [2, '第二天发言'],
    ]);
  });

  it('returns no groups for a speechless log', () => {
    expect(speechByDayOf(view())).toEqual([]);
    expect(speechByDayOf(view({ log: [{ type: 'DAY_BROKE', dayNumber: 1 }] }))).toEqual([]);
  });
});

describe('deriveTally', () => {
  it('returns null before any exile tally exists', () => {
    expect(deriveTally([])).toBeNull();
    expect(deriveTally([{ type: 'NIGHT_BEGAN', dayNumber: 1 }])).toBeNull();
  });

  it('builds the tally with the exile outcome from follow-up events', () => {
    const log: GameEvent[] = [
      {
        type: 'VOTE_TALLY',
        kind: 'exile',
        counts: [
          { seat: 7, votes: 5 },
          { seat: null, votes: 3 },
        ],
      },
      { type: 'PLAYER_EXILED', seat: 7 },
    ];
    expect(deriveTally(log)).toEqual({
      rows: [
        { target: 7, voterSeats: [], votes: 5 },
        { target: null, voterSeats: [], votes: 3 },
      ],
      abstainers: [],
      exiled: 7,
      voided: false,
    });
  });

  it('marks the vote voided when the idiot blocked it', () => {
    const log: GameEvent[] = [
      { type: 'VOTE_TALLY', kind: 'exile', counts: [{ seat: 9, votes: 12 }] },
      { type: 'EXILE_BLOCKED_BY_IDIOT', seat: 9 },
    ];
    const tally = deriveTally(log);
    expect(tally).toMatchObject({ exiled: null, voided: true });
  });

  it('ignores sheriff tallies', () => {
    expect(deriveTally([{ type: 'VOTE_TALLY', kind: 'sheriff', counts: [] }])).toBeNull();
  });
});

describe('seerResultsOf', () => {
  it('orders the seer’s private checks by seat', () => {
    expect(seerResultsOf(you({ seerChecks: { 5: 'wolf', 2: 'good' } }))).toEqual([
      { seat: 2, isWolf: false },
      { seat: 5, isWolf: true },
    ]);
    expect(seerResultsOf(you())).toEqual([]);
  });
});

describe('revealsOf and winSideOf', () => {
  it('reveals every seat at game over', () => {
    const v = view({
      phase: 'game-over',
      winner: 'good',
      you: you({ role: 'hunter' }),
      players: [
        row(1, { role: 'werewolf', alive: false }),
        row(3, { role: 'hunter', hasBadge: true }),
      ],
    });
    expect(revealsOf(v)).toEqual([
      { seat: 1, role: 'werewolf', alive: false, hasBadge: false },
      { seat: 3, role: 'hunter', alive: true, hasBadge: true },
    ]);
    expect(winSideOf(v)).toBe('good');
  });
});

describe('phaseCaptionOf', () => {
  it('names each step in Chinese', () => {
    expect(phaseCaptionOf(view({ step: { kind: 'night', step: 'wolf' } }))).toContain('狼人');
    expect(phaseCaptionOf(view({ step: { kind: 'exile-vote', electorate: [1] } }))).toContain(
      '放逐投票',
    );
    expect(phaseCaptionOf(view({ phase: 'game-over', step: { kind: 'game-over' } }))).toContain(
      '结束',
    );
  });
});

describe('seatViewsOf — lobby occupancy', () => {
  it('carries row occupancy onto the SeatView', () => {
    const v = view({
      players: [row(1, { occupied: true }), row(2, { occupied: false })],
    });
    const seats = seatViewsOf(v);
    expect(seats.find((s) => s.seat === 1)?.occupied).toBe(true);
    expect(seats.find((s) => s.seat === 2)?.occupied).toBe(false);
  });
});

describe('seatViewsOf — display names', () => {
  it('prefers the chosen name, then bot nickname, then the seat label', () => {
    const v = view({
      players: [row(1, { name: '阿明' }), row(2, { botName: '夜行者' }), row(3)],
    });
    const names = seatViewsOf(v).map((s) => [s.seat, s.name]);
    expect(names).toEqual([
      [1, '阿明'],
      [2, '夜行者'],
      [3, '3号'],
    ]);
  });
});

describe('occupiedCountOf', () => {
  it('counts seats with an occupied session, not merely living rows', () => {
    const seats = [
      { seat: 1, name: '1号', alive: true, isSelf: true, isSheriff: false, occupied: true },
      { seat: 2, name: '2号', alive: true, isSelf: false, isSheriff: false, occupied: false },
      { seat: 3, name: '3号', alive: true, isSelf: false, isSheriff: false, occupied: true },
      // Dead and unoccupied are different things; the count only reads occupancy.
      { seat: 4, name: '4号', alive: false, isSelf: false, isSheriff: false, occupied: false },
    ];
    expect(occupiedCountOf(seats)).toBe(2);
  });

  it('counts zero on an empty lobby', () => {
    expect(occupiedCountOf([])).toBe(0);
  });
});

describe('roomErrorText', () => {
  it('labels known room error codes in short zh', () => {
    expect(roomErrorText('ROOM_NOT_FULL')).toBe('人数未满，无法开局');
    expect(roomErrorText('ALREADY_STARTED')).toBe('对局已经开始');
  });

  it('passes an unknown code through so nothing is swallowed', () => {
    expect(roomErrorText('SOME_FUTURE_CODE')).toBe('操作失败（SOME_FUTURE_CODE）');
  });
});

describe('postgameStatsOf', () => {
  // A finished two-day game's client-visible log: election day, two night
  // deaths, an exile, a hunter shot, and public tallies. Server-only events
  // (DEATH_RESOLVED, *_VOTE_CAST) never appear in a PlayerView log.
  const finishedLog: GameEvent[] = [
    { type: 'GAME_STARTED' },
    { type: 'DAY_BROKE', dayNumber: 1 },
    { type: 'SPEECH_MADE', seat: 3, text: '竞选警长发言', context: 'sheriff-speech' },
    {
      type: 'VOTE_TALLY',
      kind: 'sheriff',
      counts: [{ seat: 3, votes: 8 }],
    },
    { type: 'SHERIFF_ELECTED', seat: 3 },
    { type: 'NIGHT_BEGAN', dayNumber: 1 },
    { type: 'DAY_BROKE', dayNumber: 1 },
    { type: 'DEATH_ANNOUNCED', seat: 2 },
    { type: 'SPEECH_MADE', seat: 2, text: '遗言内容', context: 'last-words' },
    {
      type: 'VOTE_TALLY',
      kind: 'exile',
      counts: [
        { seat: 7, votes: 5 },
        { seat: 11, votes: 1.5 },
        { seat: null, votes: 3 },
      ],
    },
    { type: 'PLAYER_EXILED', seat: 7 },
    { type: 'HUNTER_SHOT', shooter: 7, target: 10 },
    { type: 'NIGHT_BEGAN', dayNumber: 2 },
    { type: 'DAY_BROKE', dayNumber: 2 },
    { type: 'DEATH_ANNOUNCED', seat: 12 },
    { type: 'SPEECH_MADE', seat: 5, text: '第一天预言家发言', context: 'speech' },
    { type: 'SPEECH_MADE', seat: 5, text: '第二天预言家发言', context: 'speech' },
    {
      type: 'VOTE_TALLY',
      kind: 'exile',
      counts: [
        { seat: 6, votes: 4 },
        { seat: 7, votes: 2 },
      ],
    },
    { type: 'PLAYER_EXILED', seat: 6 },
    { type: 'GAME_OVER', winner: 'good' },
  ];

  const finishedView = view({
    phase: 'game-over',
    dayNumber: 2,
    winner: 'good',
    step: { kind: 'game-over' },
    log: finishedLog,
    players: [
      row(2, { alive: false, role: 'villager' }),
      row(3, { role: 'seer', hasBadge: true }),
      row(5, { role: 'witch' }),
      row(6, { alive: false, role: 'werewolf' }),
      row(7, { alive: false, role: 'werewolf' }),
      row(10, { alive: false, role: 'hunter' }),
      row(11, { role: 'villager' }),
      row(12, { alive: false, role: 'werewolf' }),
    ],
  });

  it('counts speeches and chars per seat, last words included', () => {
    expect(postgameStatsOf(finishedView).find((s) => s.seat === 3)).toMatchObject({
      name: '3号',
      role: 'seer',
      speeches: 1,
      speechChars: 6,
    });
    expect(postgameStatsOf(finishedView).find((s) => s.seat === 5)).toMatchObject({
      speeches: 2,
      speechChars: 16,
    });
    expect(postgameStatsOf(finishedView).find((s) => s.seat === 2)).toMatchObject({
      speeches: 1,
      speechChars: 4,
    });
  });

  it('sums weighted exile votes across tallies, ignoring abstentions and sheriff tallies', () => {
    const bySeat = new Map(postgameStatsOf(finishedView).map((s) => [s.seat, s]));
    expect(bySeat.get(7)).toMatchObject({ votesReceived: 7 }); // 5 + 2 across two tallies
    expect(bySeat.get(6)).toMatchObject({ votesReceived: 4 });
    expect(bySeat.get(11)).toMatchObject({ votesReceived: 1.5 }); // the sheriff's weighted vote
    expect(bySeat.get(3)).toMatchObject({ votesReceived: 0 }); // sheriff-kind tally ignored
  });

  it('attributes each death to its day with a public-record fate line', () => {
    const bySeat = new Map(postgameStatsOf(finishedView).map((s) => [s.seat, s]));
    expect(bySeat.get(2)).toMatchObject({ death: '首夜出局', daysSurvived: 0 });
    expect(bySeat.get(7)).toMatchObject({ death: '第1天放逐', daysSurvived: 0 });
    expect(bySeat.get(10)).toMatchObject({ death: '第1天被枪带走', daysSurvived: 0 });
    expect(bySeat.get(12)).toMatchObject({ death: '第2夜出局', daysSurvived: 1 });
    expect(bySeat.get(6)).toMatchObject({ death: '第2天放逐', daysSurvived: 1 });
  });

  it('leaves survivors unstamped and alive through the final day', () => {
    const bySeat = new Map(postgameStatsOf(finishedView).map((s) => [s.seat, s]));
    expect(bySeat.get(3)).toMatchObject({ death: null, daysSurvived: 2 });
    expect(bySeat.get(11)).toMatchObject({ death: null, daysSurvived: 2 });
  });

  it('splits the 白狼王 destruct into self-destruct and taken-target fates', () => {
    const destructLog: GameEvent[] = [
      { type: 'NIGHT_BEGAN', dayNumber: 2 },
      { type: 'DAY_BROKE', dayNumber: 2 },
      { type: 'WHITE_WOLF_KING_DESTRUCTED', actor: 9, target: 4 },
    ];
    const destructView = view({
      phase: 'game-over',
      dayNumber: 2,
      log: destructLog,
      players: [
        row(4, { alive: false, role: 'witch' }),
        row(9, { alive: false, role: 'werewolf' }),
      ],
    });
    const bySeat = new Map(postgameStatsOf(destructView).map((s) => [s.seat, s]));
    expect(bySeat.get(9)).toMatchObject({ death: '第2天自爆出局', daysSurvived: 1 });
    expect(bySeat.get(4)).toMatchObject({ death: '第2天被自爆带走', daysSurvived: 1 });
  });

  it('reports no stats for rows without a revealed role', () => {
    expect(postgameStatsOf(view({ players: [row(3), row(5)] }))).toEqual([]);
  });
});
