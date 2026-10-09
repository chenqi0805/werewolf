import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/engine';
import type { PlayerView, YouView } from '@werewolf/server';

import {
  deriveTally,
  logToEntries,
  phaseCaptionOf,
  revealsOf,
  seerResultsOf,
  seatViewsOf,
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
  you: you(),
  players: [],
  step: { kind: 'lobby' },
  log: [],
  timer: null,
  ...overrides,
});

const row = (seat: number, overrides: Partial<PlayerView['players'][number]> = {}) => ({
  seat,
  alive: true,
  hasBadge: false,
  revealedIdiot: false,
  voteWeight: 1,
  role: null,
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
    const messages = speechMessagesOf(log);
    expect(messages).toEqual([
      { id: 'sp-0', seat: 3, name: '3号', text: '过' },
      { id: 'sp-1', seat: 5, name: '5号', text: '我是预言家' },
    ]);
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
