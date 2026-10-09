import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/engine';
import type { PlayerView } from '@werewolf/server';

import {
  canSpeakNow,
  canVoteNow,
  directionNeeded,
  formatCountdown,
  hunterShotState,
  msLeftOf,
  nightPadKind,
  nightTargets,
  poisonTargets,
  seerTargets,
  sheriffSignupState,
  speechContextOf,
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
  alive: true,
  hasBadge: false,
  revealedIdiot: false,
  voteWeight: 1,
  role: null,
  ...overrides,
});

const view = (overrides: Partial<PlayerView> = {}): PlayerView => ({
  phase: 'night',
  dayNumber: 1,
  winner: null,
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

  it('offers living unchecked players to the seer', () => {
    const seerView = view({
      you: you({ role: 'seer', seerChecks: { 2: 'good' } }),
      players: [row(1), row(2), row(3), row(4, { alive: false })],
    });
    expect(seerTargets(seerView).map((t) => t.seat)).toEqual([1]); // self and checked seats excluded
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
