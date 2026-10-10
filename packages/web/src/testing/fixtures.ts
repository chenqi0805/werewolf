import type { PostgameReply } from '@werewolf/server';

import type { PlayerPostgameStat, SpeechRecord, SeatView, VoteRound, VoteTally } from '../types';

let nextId = 0;

/** Unique-per-call message id so story keys never collide. */
export function nextMessageId(): string {
  nextId += 1;
  return `msg-${nextId}`;
}

/** SeatView with sensible defaults; override any field per story. */
export function makeSeatView(overrides: Partial<SeatView> & { seat: number }): SeatView {
  return {
    name: `${overrides.seat}号玩家`,
    alive: true,
    isSelf: false,
    isSheriff: false,
    occupied: true,
    ...overrides,
  };
}

const fullRoster: SeatView[] = [
  { seat: 1, name: '法官最讨厌的人', alive: true, isSelf: true, isSheriff: true, occupied: true },
  { seat: 2, name: '首夜倒牌', alive: false, isSelf: false, isSheriff: false, occupied: true },
  { seat: 3, name: '查杀发言', alive: true, isSelf: false, isSheriff: false, occupied: true },
  { seat: 4, name: '沉默农民', alive: true, isSelf: false, isSheriff: false, occupied: true },
  {
    seat: 5,
    name: '翻牌白痴',
    alive: true,
    isSelf: false,
    isSheriff: false,
    occupied: true,
    revealedIdiot: true,
  },
  { seat: 6, name: '带毒女巫', alive: true, isSelf: false, isSheriff: false, occupied: true },
  {
    seat: 7,
    name: '起跳预言家',
    alive: true,
    isSelf: false,
    isSheriff: false,
    occupied: true,
    isSpeaking: true,
  },
  { seat: 8, name: '冲锋猎人', alive: true, isSelf: false, isSheriff: false, occupied: true },
  { seat: 9, name: '金水发言', alive: true, isSelf: false, isSheriff: false, occupied: true },
  { seat: 10, name: '划水农民', alive: true, isSelf: false, isSheriff: false, occupied: true },
  { seat: 11, name: '悍跳狼', alive: true, isSelf: false, isSheriff: false, occupied: true },
  { seat: 12, name: '弃票观众', alive: true, isSelf: false, isSheriff: false, occupied: true },
];

/** The canonical 12-seat board used by grid, pads, and spectator stories. */
export function fullBoard(): SeatView[] {
  return fullRoster.map((view) => ({ ...view }));
}

/** Living seats other than 1 (self) — typical wolf-pad target set. */
export function livingTargets(): SeatView[] {
  return fullRoster.filter((view) => view.alive && view.seat !== 1).map((view) => ({ ...view }));
}

/** A resolved 4-row tally with a sheriff's 1.5 vote on the exiled seat. */
export function sampleTally(): VoteTally {
  return {
    rows: [
      { target: 11, voterSeats: [1, 3, 9], votes: 3.5 },
      { target: 7, voterSeats: [4, 8], votes: 2 },
      { target: 4, voterSeats: [6], votes: 1 },
      { target: null, voterSeats: [12], votes: 0 },
    ],
    abstainers: [12],
    exiled: 11,
    voided: false,
  };
}

/** Two days of speeches across all four contexts — the history-panel fixture. */
export function sampleSpeechGroups(): Array<{ day: number; records: SpeechRecord[] }> {
  return [
    {
      day: 1,
      records: [
        {
          day: 1,
          context: 'sheriff-speech',
          seat: 3,
          name: '3号',
          text: '我上警是想带节奏，昨晚的局势我看得比较清楚，大家给我一个警徽位置。',
        },
        {
          day: 1,
          context: 'last-words',
          seat: 2,
          name: '2号',
          text: '我是平民。7号昨天发言一直在划水，你们放逐我之后要盯住他。',
        },
        {
          day: 1,
          context: 'speech',
          seat: 5,
          name: '5号',
          text: '我是预言家，昨晚查验了3号，他是查杀。今天请全部票型跟我的警徽流走。',
        },
      ],
    },
    {
      day: 2,
      records: [
        {
          day: 2,
          context: 'speech',
          seat: 9,
          name: '9号',
          text: '昨天放逐7号之后平安夜，说明我们可能放错了。今天听后置位的发言再定票。',
        },
        {
          day: 2,
          context: 'pk-speech',
          seat: 5,
          name: '5号',
          text: '我再报一次验人：1号金水。11号悍跳狼，发言全是套话，票他。',
        },
        {
          day: 2,
          context: 'pk-speech',
          seat: 11,
          name: '11号',
          text: '我才是真预言家，5号的警徽流自相矛盾，他退不下去了。',
        },
      ],
    },
  ];
}

/**
 * A finished two-day board's deterministic stats — every wolf dead (放逐,
 * 枪, 自爆), five seats surviving. Mirrors what the postgameStatsOf adapter
 * derives from a client-visible game-over log.
 */
export function samplePostgameStats(): PlayerPostgameStat[] {
  return [
    {
      seat: 1,
      name: '1号',
      role: 'seer',
      speeches: 2,
      speechChars: 64,
      daysSurvived: 2,
      votesCast: 0,
      votesReceived: 0,
      death: null,
    },
    {
      seat: 2,
      name: '2号',
      role: 'villager',
      speeches: 1,
      speechChars: 22,
      daysSurvived: 0,
      votesCast: 0,
      votesReceived: 0,
      death: '首夜出局',
    },
    {
      seat: 3,
      name: '3号',
      role: 'witch',
      speeches: 2,
      speechChars: 58,
      daysSurvived: 2,
      votesCast: 0,
      votesReceived: 0,
      death: null,
    },
    {
      seat: 4,
      name: '4号',
      role: 'werewolf',
      speeches: 1,
      speechChars: 30,
      daysSurvived: 0,
      votesCast: 0,
      votesReceived: 5,
      death: '第1天放逐',
    },
    {
      seat: 5,
      name: '5号',
      role: 'werewolf',
      speeches: 2,
      speechChars: 52,
      daysSurvived: 1,
      votesCast: 0,
      votesReceived: 4,
      death: '第2天放逐',
    },
    {
      seat: 6,
      name: '6号',
      role: 'villager',
      speeches: 1,
      speechChars: 26,
      daysSurvived: 1,
      votesCast: 0,
      votesReceived: 0,
      death: '第2夜出局',
    },
    {
      seat: 7,
      name: '7号',
      role: 'hunter',
      speeches: 2,
      speechChars: 74,
      daysSurvived: 2,
      votesCast: 0,
      votesReceived: 1.5,
      death: null,
    },
    {
      seat: 8,
      name: '8号',
      role: 'villager',
      speeches: 0,
      speechChars: 0,
      daysSurvived: 1,
      votesCast: 0,
      votesReceived: 0,
      death: '第2天被自爆带走',
    },
    {
      seat: 9,
      name: '9号',
      role: 'idiot',
      speeches: 2,
      speechChars: 66,
      daysSurvived: 2,
      votesCast: 0,
      votesReceived: 3,
      death: null,
    },
    {
      seat: 10,
      name: '10号',
      role: 'werewolf',
      speeches: 0,
      speechChars: 0,
      daysSurvived: 0,
      votesCast: 0,
      votesReceived: 2,
      death: '第1天被枪带走',
    },
    {
      seat: 11,
      name: '11号',
      role: 'villager',
      speeches: 2,
      speechChars: 60,
      daysSurvived: 2,
      votesCast: 0,
      votesReceived: 0,
      death: null,
    },
    {
      seat: 12,
      name: '12号',
      role: 'white_wolf_king',
      speeches: 1,
      speechChars: 18,
      daysSurvived: 1,
      votesCast: 0,
      votesReceived: 1,
      death: '第2天自爆出局',
    },
  ];
}

/** The shared 复盘 reply the AI block renders — MVP is the hunter on 7号. */
export function samplePostgameReply(): PostgameReply {
  return {
    summary:
      '狼队首夜刀掉2号试探，白天好人借警徽流放逐悍跳狼4号，猎人7号随即开枪带走10号补刀。第2夜狼队偷袭6号，第2天好人放逐5号收网；白狼王自爆带走8号已无力回天，好人阵营完成屠狼。',
    keyMoments: [
      '首夜狼刀带走2号，遗言指向4号。',
      '第1天警徽流带票，4号被放逐，猎人开枪带走10号。',
      '第2夜狼刀6号，好人白天放逐5号。',
      '白狼王自爆带走8号，狼队仍差一步屠边。',
    ],
    mvp: 7,
    ratings: [
      {
        seat: 1,
        score: 8,
        rationale: '开局报验果断，警徽流清晰。',
        highlight: '金水链稳住好人视野。',
      },
      {
        seat: 2,
        score: 5,
        rationale: '首夜出局，遗言信息有限。',
        highlight: '遗言点出4号发言疑点。',
      },
      {
        seat: 3,
        score: 7,
        rationale: '解药留到关键夜，毒未误伤。',
        highlight: '解药救下首夜刀口。',
      },
      { seat: 4, score: 4, rationale: '悍跳仓促，票型暴露身份。', highlight: '白天带偏一轮投票。' },
      {
        seat: 5,
        score: 3,
        rationale: '发言摇摆，自证无力。',
        highlight: '第2天几乎骗过好人票型。',
      },
      { seat: 6, score: 5, rationale: '站边正确但缺少输出。', highlight: '第2天归票坚定。' },
      {
        seat: 7,
        score: 9,
        rationale: '全场最强节奏掌控，枪口精准。',
        highlight: '带走10号狼牌锁定胜局。',
      },
      {
        seat: 8,
        score: 4,
        rationale: '发言较少，存在感低。',
        highlight: '被自爆带走前提醒好人归票。',
      },
      {
        seat: 9,
        score: 6,
        rationale: '翻牌后发言稳住，拖住狼队节奏。',
        highlight: '放逐无效白吃狼队一票。',
      },
      { seat: 10, score: 4, rationale: '冲锋过猛，早早暴露。', highlight: '试图自水身份未果。' },
      {
        seat: 11,
        score: 7,
        rationale: '后置位发言清晰，归票准确。',
        highlight: '组织好人统一票型。',
      },
      {
        seat: 12,
        score: 6,
        rationale: '自爆时机精准，为狼队续命。',
        highlight: '自爆带走8号好人。',
      },
    ],
  };
}

/** Ballot triple [voter, target|null, weight=1], voter-ascending like the engine emits. */
function ballotsOf(entries: Array<[number, number | null, number?]>): VoteRound['ballots'] {
  return entries.map(([voter, target, weight = 1]) => ({ voter, target, weight }));
}

/**
 * Four coherent rounds from one classic-board game: the day-1 election
 * (9号 elected), the day-1 exile that flips the unrevealed idiot (12号),
 * the day-2 exile tie that goes to PK, and the PK revote tying again into
 * a void day. Badge on 9号 (1.5); 12号 stopped voting after the flip;
 * 8号 died on night 2. Covers every round shape the panel renders.
 */
export function sampleVoteRounds(): VoteRound[] {
  return [
    {
      kind: 'sheriff',
      day: 1,
      revote: false,
      counts: [
        { seat: 9, votes: 8 },
        { seat: null, votes: 1 },
      ],
      ballots: ballotsOf([
        [1, 9],
        [2, 9],
        [3, 9],
        [4, 9],
        [6, 9],
        [7, 9],
        [8, 9],
        [11, 9],
        [12, null],
      ]),
      outcome: { kind: 'elected', seat: 9 },
    },
    {
      kind: 'exile',
      day: 1,
      revote: false,
      counts: [
        { seat: 12, votes: 10.5 },
        { seat: 3, votes: 1 },
      ],
      ballots: ballotsOf([
        [1, 12],
        [2, 12],
        [3, 12],
        [4, 12],
        [6, 12],
        [7, 12],
        [8, 12],
        [9, 12, 1.5],
        [10, 12],
        [11, 12],
        [12, 3],
      ]),
      outcome: { kind: 'idiot-revealed', seat: 12 },
    },
    {
      kind: 'exile',
      day: 2,
      revote: false,
      counts: [
        { seat: 6, votes: 3 },
        { seat: 7, votes: 3 },
        { seat: null, votes: 3.5 },
      ],
      ballots: ballotsOf([
        [1, 6],
        [2, 7],
        [3, 6],
        [4, 7],
        [6, null],
        [7, null],
        [9, null, 1.5],
        [10, 6],
        [11, 7],
      ]),
      outcome: { kind: 'pk' },
    },
    {
      kind: 'exile',
      day: 2,
      revote: true,
      counts: [
        { seat: 6, votes: 3 },
        { seat: 7, votes: 3 },
        { seat: null, votes: 1.5 },
      ],
      ballots: ballotsOf([
        [1, 6],
        [2, 7],
        [3, 6],
        [4, 7],
        [9, null, 1.5],
        [10, 6],
        [11, 7],
      ]),
      outcome: { kind: 'void' },
    },
  ];
}
