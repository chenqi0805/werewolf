import type { SeatView, VoteTally } from '../types';

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
    ...overrides,
  };
}

const fullRoster: SeatView[] = [
  { seat: 1, name: '法官最讨厌的人', alive: true, isSelf: true, isSheriff: true },
  { seat: 2, name: '首夜倒牌', alive: false, isSelf: false, isSheriff: false },
  { seat: 3, name: '查杀发言', alive: true, isSelf: false, isSheriff: false },
  { seat: 4, name: '沉默农民', alive: true, isSelf: false, isSheriff: false },
  { seat: 5, name: '翻牌白痴', alive: true, isSelf: false, isSheriff: false, revealedIdiot: true },
  { seat: 6, name: '带毒女巫', alive: true, isSelf: false, isSheriff: false },
  { seat: 7, name: '起跳预言家', alive: true, isSelf: false, isSheriff: false, isSpeaking: true },
  { seat: 8, name: '冲锋猎人', alive: true, isSelf: false, isSheriff: false },
  { seat: 9, name: '金水发言', alive: true, isSelf: false, isSheriff: false },
  { seat: 10, name: '划水农民', alive: true, isSelf: false, isSheriff: false },
  { seat: 11, name: '悍跳狼', alive: true, isSelf: false, isSheriff: false },
  { seat: 12, name: '弃票观众', alive: true, isSelf: false, isSheriff: false },
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
