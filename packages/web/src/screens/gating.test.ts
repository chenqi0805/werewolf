import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/engine';
import type { PlayerView } from '@werewolf/server';

import {
  actionFor,
  canSpeakNow,
  canVoteNow,
  directionNeeded,
  formatCountdown,
  destructState,
  explodeState,
  guardOptionsOf,
  guardTargets,
  hunterShotState,
  msLeftOf,
  nightPadKind,
  nightTargets,
  poisonTargets,
  seerTargets,
  sheriffSignupState,
  speechContextOf,
  speechSlotKeyOf,
  strategyContextOf,
  voteContextOf,
} from './gating';

const you = (overrides: Partial<PlayerView['you']> = {}): PlayerView['you'] => ({
  seat: 3,
  role: null,
  alive: true,
  hasBadge: false,
  revealedIdiot: false,
  voteWeight: 1,
  ...overrides,
});

const row = (seat: number, overrides: Partial<PlayerView['players'][number]> = {}) => ({
  seat,
  name: '',
  alive: true,
  hasBadge: false,
  revealedIdiot: false,
  voteWeight: 1,
  occupied: true,
  isBot: false,
  botName: null,
  role: null,
  ...overrides,
});

const view = (overrides: Partial<PlayerView> = {}): PlayerView => ({
  phase: 'night',
  dayNumber: 1,
  winner: null,
  board: 'classic',
  you: you(),
  players: [row(1), row(2), row(3), row(4), row(5)],
  step: { kind: 'night', step: 'wolf' },
  log: [],
  timer: null,
  ...overrides,
});

describe('nightPadKind', () => {
  it('routes the pad by role and night step', () => {
    expect(
      nightPadKind(view({ you: you({ role: 'werewolf' }), step: { kind: 'night', step: 'wolf' } })),
    ).toBe('wolf');
    expect(
      nightPadKind(view({ you: you({ role: 'witch' }), step: { kind: 'night', step: 'witch' } })),
    ).toBe('witch');
    expect(
      nightPadKind(view({ you: you({ role: 'seer' }), step: { kind: 'night', step: 'seer' } })),
    ).toBe('seer');
  });

  it('routes the pending guard window to the guard alone', () => {
    const pending: PlayerView['step'] = { kind: 'night', step: 'wolf', guardPending: true };
    expect(nightPadKind(view({ you: you({ role: 'guard' }), step: pending }))).toBe('guard');
    // While the guard pends, the wolves wait — their actions would be rejected.
    expect(nightPadKind(view({ you: you({ role: 'werewolf' }), step: pending }))).toBe('waiting');
    expect(
      nightPadKind(view({ you: you({ role: 'guard' }), step: { kind: 'night', step: 'wolf' } })),
    ).toBe('waiting');
  });

  it('gives the 白狼王 the wolf pad for the kill, but only that step', () => {
    expect(
      nightPadKind(
        view({ you: you({ role: 'white_wolf_king' }), step: { kind: 'night', step: 'wolf' } }),
      ),
    ).toBe('wolf');
    // His pack targets flow from the projected wolfPack, same as any wolf.
    const kingView = view({
      you: you({ role: 'white_wolf_king', wolfPack: [4, 12] }),
      players: [row(1), row(2), row(3, { alive: false }), row(4), row(5)],
    });
    expect(nightTargets(kingView).map((t) => t.seat)).toEqual([1, 2, 5]);
    expect(
      nightPadKind(
        view({ you: you({ role: 'white_wolf_king' }), step: { kind: 'night', step: 'witch' } }),
      ),
    ).toBe('waiting');
  });

  it('shows a waiting pad for bystanders and other steps', () => {
    expect(nightPadKind(view({ you: you({ role: 'villager' }) }))).toBe('waiting');
    expect(
      nightPadKind(view({ you: you({ role: 'werewolf' }), step: { kind: 'night', step: 'seer' } })),
    ).toBe('waiting');
    expect(
      nightPadKind(
        view({ you: you({ role: 'witch', alive: false }), step: { kind: 'night', step: 'witch' } }),
      ),
    ).toBe('waiting');
    expect(nightPadKind(view({ you: you({ seat: null, role: 'witch' }) }))).toBe('waiting');
  });
});

describe('target selectors', () => {
  const wolfView = view({
    you: you({ role: 'werewolf', wolfPack: [1, 3] }),
    players: [row(1), row(2), row(3, { alive: false }), row(4), row(5)],
  });

  it('offers living non-wolves to the pack', () => {
    expect(nightTargets(wolfView).map((t) => t.seat)).toEqual([2, 4, 5]);
  });

  it('offers living others to the witch’s poison', () => {
    expect(poisonTargets(wolfView).map((t) => t.seat)).toEqual([1, 2, 4, 5]);
  });

  it('hands the guard his options and living others as protectees', () => {
    const guardView = view({
      step: { kind: 'night', step: 'wolf', guardPending: true },
      you: you({
        role: 'guard',
        guardOptions: { maySelfProtect: true, mayPass: true, repeatBan: true, lastProtected: 2 },
      }),
      players: [row(1), row(2), row(3, { alive: false }), row(4), row(5)],
    });
    expect(guardOptionsOf(guardView)).toEqual({
      maySelfProtect: true,
      mayPass: true,
      repeatBan: true,
      lastProtected: 2,
    });
    expect(guardTargets(guardView).map((t) => t.seat)).toEqual([1, 2, 4, 5]); // self excluded
    // A non-guard gets no options even during the pending window.
    expect(
      guardOptionsOf(
        view({
          you: you({ role: 'seer' }),
          step: { kind: 'night', step: 'wolf', guardPending: true },
        }),
      ),
    ).toBeNull();
    expect(guardOptionsOf(view({ you: you({ role: 'guard', alive: false }) }))).toBeNull();
  });

  it('offers living unchecked players to the seer', () => {
    const seerView = view({
      you: you({ role: 'seer', seerChecks: { 2: 'good' } }),
      players: [row(1), row(2), row(3), row(4, { alive: false })],
    });
    expect(seerTargets(seerView).map((t) => t.seat)).toEqual([1]); // self and checked seats excluded
  });
});

describe('destructState', () => {
  const kingView = (step: PlayerView['step'], overrides: Partial<PlayerView['you']> = {}) =>
    view({
      step,
      you: you({ role: 'white_wolf_king', seat: 4, ...overrides }),
      players: [row(1), row(2), row(3, { alive: false }), row(4), row(5)],
    });

  it('opens for a living king during the day speech rounds', () => {
    expect(destructState(kingView({ kind: 'speech', order: [4, 5], cursor: 0 })).active).toBe(true);
    expect(destructState(kingView({ kind: 'pk-speech', tied: [4, 5], cursor: 0 })).active).toBe(
      true,
    );
    const state = destructState(kingView({ kind: 'speech', order: [5], cursor: 0 }));
    expect(state.targets.map((t) => t.seat)).toEqual([1, 2, 5]); // living others only
  });

  it('opens at the dead king’s own exile settlement', () => {
    const settlement: PlayerView['step'] = { kind: 'hunter-shot', seat: 4 };
    expect(destructState(kingView(settlement, { alive: false })).active).toBe(true);
    // Another seat's shot window is not his.
    expect(destructState(kingView({ kind: 'hunter-shot', seat: 8 }, { alive: false })).active).toBe(
      false,
    );
  });

  it('stays shut outside his windows, once used, and for other roles', () => {
    expect(destructState(kingView({ kind: 'night', step: 'wolf' })).active).toBe(false);
    expect(
      destructState(kingView({ kind: 'speech', order: [4], cursor: 0 }, { destructUsed: true }))
        .active,
    ).toBe(false);
    expect(destructState(view({ you: you({ role: 'werewolf', seat: 4 }) })).active).toBe(false);
    expect(destructState(view({ you: you({ role: 'hunter', seat: 4 }) })).active).toBe(false);
  });

  it('builds the destruct action', () => {
    const king = kingView({ kind: 'speech', order: [4], cursor: 0 });
    expect(actionFor(king, 'destruct', 7)).toEqual({
      type: 'WOLF_KING_DESTRUCT',
      actor: 4,
      target: 7,
    });
  });
});

describe('explodeState', () => {
  const wolfView = (step: PlayerView['step'], overrides: Partial<PlayerView['you']> = {}) =>
    view({
      step,
      you: you({ role: 'werewolf', seat: 4, ...overrides }),
      players: [row(1), row(2), row(3, { alive: false }), row(4), row(5)],
    });

  it('opens for a living plain wolf in every voice-live window', () => {
    expect(explodeState(wolfView({ kind: 'sheriff-signup', candidates: [4] })).active).toBe(true);
    expect(explodeState(wolfView({ kind: 'sheriff-speech', queue: [4], cursor: 0 })).active).toBe(
      true,
    );
    expect(explodeState(wolfView({ kind: 'speech', order: [4, 5], cursor: 0 })).active).toBe(true);
    expect(explodeState(wolfView({ kind: 'pk-speech', tied: [4, 5], cursor: 0 })).active).toBe(
      true,
    );
  });

  it('stays shut outside the windows — ballots and night are never interrupted', () => {
    expect(explodeState(wolfView({ kind: 'night', step: 'wolf' })).active).toBe(false);
    expect(explodeState(wolfView({ kind: 'sheriff-vote', electorate: [1, 2] })).active).toBe(false);
    expect(explodeState(wolfView({ kind: 'exile-vote', electorate: [1, 2] })).active).toBe(false);
    expect(
      explodeState(wolfView({ kind: 'pk-vote', electorate: [1, 2], voteKind: 'exile' })).active,
    ).toBe(false);
    expect(explodeState(wolfView({ kind: 'dawn-announce', remaining: 1 })).active).toBe(false);
    expect(explodeState(wolfView({ kind: 'game-over' })).active).toBe(false);
  });

  it('stays shut for the 白狼王, other roles, and dead or seatless wolves', () => {
    const speaking: PlayerView['step'] = { kind: 'speech', order: [4], cursor: 0 };
    // The king's destruct is targeted and separate — he never plain-explodes.
    expect(
      explodeState(view({ step: speaking, you: you({ role: 'white_wolf_king', seat: 4 }) })).active,
    ).toBe(false);
    expect(explodeState(view({ step: speaking, you: you({ role: 'seer', seat: 4 }) })).active).toBe(
      false,
    );
    expect(explodeState(view({ step: speaking, you: you({ role: null, seat: 4 }) })).active).toBe(
      false,
    );
    expect(explodeState(wolfView(speaking, { alive: false })).active).toBe(false);
    expect(
      explodeState(view({ step: speaking, you: you({ role: 'werewolf', seat: null }) })).active,
    ).toBe(false);
  });
});

describe('actionFor', () => {
  it('builds the guard protect action and rejects empty targets', () => {
    const guardView = view({ you: you({ role: 'guard', seat: 12 }) });
    expect(actionFor(guardView, 'protect', 7)).toEqual({
      type: 'GUARD_PROTECT',
      actor: 12,
      target: 7,
    });
    expect(actionFor(guardView, 'protect', null)).toBeNull();
    expect(actionFor(view({ you: you({ seat: null, role: 'guard' }) }), 'protect', 7)).toBeNull();
  });
});

describe('voteContextOf and canVoteNow', () => {
  it('routes the ballot action by step kind, including PK votes', () => {
    expect(
      voteContextOf(view({ step: { kind: 'sheriff-vote', electorate: [3] } }))?.actionKind,
    ).toBe('SHERIFF_VOTE');
    expect(voteContextOf(view({ step: { kind: 'exile-vote', electorate: [3] } }))?.actionKind).toBe(
      'EXILE_VOTE',
    );
    expect(
      voteContextOf(view({ step: { kind: 'pk-vote', electorate: [3], voteKind: 'sheriff' } }))
        ?.actionKind,
    ).toBe('SHERIFF_VOTE');
    expect(
      voteContextOf(view({ step: { kind: 'pk-vote', electorate: [3], voteKind: 'exile' } }))
        ?.actionKind,
    ).toBe('EXILE_VOTE');
    expect(voteContextOf(view({ step: { kind: 'night', step: 'wolf' } }))).toBeNull();
  });

  it('gates the ballot to living electorate seats with rights', () => {
    const v = view({ step: { kind: 'exile-vote', electorate: [2, 3] } });
    expect(canVoteNow(v)).toBe(true);
    expect(canVoteNow({ ...v, you: you({ seat: 1 }) })).toBe(false); // not in electorate
    expect(canVoteNow({ ...v, you: you({ alive: false }) })).toBe(false);
    expect(canVoteNow({ ...v, you: you({ voteWeight: 0 }) })).toBe(false); // revealed idiot
  });
});

describe('canSpeakNow and speechContextOf', () => {
  it('lets only the current speaker post', () => {
    const v = view({ step: { kind: 'speech', order: [3, 4], cursor: 0 } });
    expect(canSpeakNow(v)).toBe(true);
    expect(canSpeakNow({ ...v, step: { kind: 'speech', order: [3, 4], cursor: 1 } })).toBe(false);
    expect(canSpeakNow({ ...v, step: { kind: 'last-words', queue: [3], cursor: 0 } })).toBe(true);
    expect(canSpeakNow({ ...v, step: { kind: 'night', step: 'wolf' } })).toBe(false);
    expect(
      canSpeakNow({
        ...v,
        you: you({ alive: false }),
        step: { kind: 'speech', order: [3], cursor: 0 },
      }),
    ).toBe(false);
  });

  it('lets a dead viewer speak only in their own last-words slot', () => {
    const dead = you({ alive: false });
    expect(
      canSpeakNow(view({ you: dead, step: { kind: 'last-words', queue: [3], cursor: 0 } })),
    ).toBe(true); // the server queues the just-dead seat and accepts its SPEAK
    expect(
      canSpeakNow(view({ you: dead, step: { kind: 'last-words', queue: [4], cursor: 0 } })),
    ).toBe(false); // another seat's last words
    expect(
      canSpeakNow(view({ you: dead, step: { kind: 'speech', order: [4], cursor: 0 } })),
    ).toBe(false); // dead seats never hold the day speech
  });

  it('exposes the speech context for panel captions', () => {
    expect(speechContextOf(view({ step: { kind: 'sheriff-speech', queue: [3], cursor: 0 } }))).toBe(
      'sheriff-speech',
    );
    expect(speechContextOf(view({ step: { kind: 'night', step: 'wolf' } }))).toBeNull();
  });
});

describe('strategyContextOf', () => {
  const log: GameEvent[] = [
    { type: 'SPEECH_MADE', seat: 1, text: '我怀疑后置位的两个人。', context: 'speech' },
  ];

  it('offers the current speaker their role and the day-grouped record', () => {
    const context = strategyContextOf(
      view({
        you: you({ role: 'seer' }),
        step: { kind: 'speech', order: [3, 4], cursor: 0 },
        log,
      }),
    );
    expect(context?.role).toBe('seer');
    expect(context?.dayRecords).toEqual([
      {
        day: 1,
        records: [
          { day: 1, context: 'speech', seat: 1, name: '1号', text: '我怀疑后置位的两个人。' },
        ],
      },
    ]);
  });

  it('hides while another seat holds the mic', () => {
    expect(
      strategyContextOf(view({ step: { kind: 'speech', order: [3, 4], cursor: 1 }, log })),
    ).toBeNull();
  });

  it('hides until someone has spoken', () => {
    expect(
      strategyContextOf(view({ step: { kind: 'speech', order: [3, 4], cursor: 0 } })),
    ).toBeNull();
  });

  it('hides dead viewers and non-speech steps', () => {
    expect(
      strategyContextOf(
        view({
          you: you({ alive: false }),
          step: { kind: 'speech', order: [3], cursor: 0 },
          log,
        }),
      ),
    ).toBeNull();
    expect(strategyContextOf(view({ step: { kind: 'night', step: 'wolf' }, log }))).toBeNull();
  });
});

describe('sheriffSignupState', () => {
  it('gates signup and withdraw by candidacy', () => {
    const v = view({ step: { kind: 'sheriff-signup', candidates: [1, 2] } });
    const state1 = sheriffSignupState(v);
    expect(state1.signedUp).toBe(false);
    expect(state1.canSignup).toBe(true);
    expect(state1.canWithdraw).toBe(false);
    expect(state1.candidates.map((r) => r.seat)).toEqual([1, 2]);
    const state2 = sheriffSignupState({ ...v, you: you({ seat: 1 }) });
    expect(state2.signedUp).toBe(true);
    expect(state2.canSignup).toBe(false);
    expect(state2.canWithdraw).toBe(true);
    expect(sheriffSignupState({ ...v, you: you({ seat: 3, alive: false }) }).canSignup).toBe(false);
  });
});

describe('hunterShotState', () => {
  it('arms only the hunter whose window is open and whose shot is unspent', () => {
    const v = view({
      step: { kind: 'hunter-shot', seat: 3 },
      you: you({ role: 'hunter' }),
      players: [row(1, { alive: false }), row(2), row(3), row(4, { alive: false }), row(5)],
    });
    const shot = hunterShotState(v);
    expect(shot.active).toBe(true);
    expect(shot.targets.map((t) => t.seat)).toEqual([2, 5]);

    expect(hunterShotState({ ...v, step: { kind: 'hunter-shot', seat: 2 } }).active).toBe(false);
    expect(
      hunterShotState({ ...v, you: you({ role: 'hunter', hunterShotUsed: true }) }).active,
    ).toBe(false);
    expect(hunterShotState({ ...v, you: you({ role: 'villager' }) }).active).toBe(false);
  });
});

describe('directionNeeded', () => {
  it('asks only the sheriff while the speech order is unset', () => {
    expect(directionNeeded(view({ step: { kind: 'speech', order: null, cursor: 0 } }))).toBe(false);
    expect(
      directionNeeded(
        view({ step: { kind: 'speech', order: null, cursor: 0 }, you: you({ hasBadge: true }) }),
      ),
    ).toBe(true);
    expect(
      directionNeeded(
        view({ step: { kind: 'speech', order: [3], cursor: 0 }, you: you({ hasBadge: true }) }),
      ),
    ).toBe(false);
  });
});

describe('countdown formatters', () => {
  it('formats the remaining time as m:ss', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-1_000)).toBe('0:00');
  });

  it('derives milliseconds left from the timer and now', () => {
    expect(msLeftOf({ key: 'night:wolf', endsAt: 10_000 }, 7_000)).toBe(3_000);
    expect(msLeftOf({ key: 'night:wolf', endsAt: 10_000 }, 12_000)).toBe(0);
    expect(msLeftOf(null, 1_000)).toBeNull();
  });
});

describe('speechSlotKeyOf', () => {
  it('names the speech context, clock key, and deadline', () => {
    const timer = { key: 'speech', endsAt: 900_000 };
    const v = view({ step: { kind: 'speech', order: [3], cursor: 0 }, timer });
    expect(speechSlotKeyOf(v)).toBe('speech:speech:900000');
    expect(
      speechSlotKeyOf(view({ step: { kind: 'last-words', queue: [3], cursor: 0 }, timer })),
    ).toBe('last-words:speech:900000');
  });

  it('is null outside speech slots', () => {
    expect(speechSlotKeyOf(view())).toBeNull();
    expect(
      speechSlotKeyOf(view({ step: { kind: 'exile-vote', electorate: [1, 2, 3] } })),
    ).toBeNull();
  });

  it('changes when the slot moves on — new deadline or new clock', () => {
    const base = view({ step: { kind: 'speech', order: [3], cursor: 0 } });
    const a = speechSlotKeyOf(view({ ...base, timer: { key: 'speech', endsAt: 900_000 } }));
    // Same clock advanced: a fresh slot for the next speaker.
    const b = speechSlotKeyOf(view({ ...base, timer: { key: 'speech', endsAt: 975_000 } }));
    // A different clock key (phase moved) is a different slot even at the same ms.
    const c = speechSlotKeyOf(view({ ...base, timer: { key: 'pk-speech', endsAt: 900_000 } }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('falls back to the log length when the slot runs without a clock', () => {
    const v = view({ step: { kind: 'speech', order: [3], cursor: 0 }, timer: null });
    expect(speechSlotKeyOf(v)).toBe('speech:log:0');
    expect(speechSlotKeyOf({ ...v, log: [{} as PlayerView['log'][number]] })).toBe('speech:log:1');
  });
});
