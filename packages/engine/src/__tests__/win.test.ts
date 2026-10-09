import { describe, expect, it } from 'vitest';
import { winCheck } from '../index';
import type { newGame } from './harness';
import { apply, baseGame, expectGameError, openDay, runNight, voteAll } from './harness';

describe('win — 屠边 checks', () => {
  it('wolves win when every villager is dead', () => {
    let s = baseGame(); // villager 5 died on night 1
    for (const target of [6, 7]) {
      s = voteAll(s, 'EXILE_VOTE', null); // the day abstains
      s = runNight(s, { kill: target });
      s = openDay(s);
    }
    s = voteAll(s, 'EXILE_VOTE', null);
    s = runNight(s, { kill: 8 }); // the last villager falls at night
    expect(s.winner).toBe('wolves');
    expect(s.phase).toBe('game-over');
    expect(s.log.filter((e) => e.type === 'GAME_OVER')).toHaveLength(1);
  });

  it('wolves win when all four gods are dead', () => {
    let s = baseGame(); // seer 9 is sheriff
    s = voteAll(s, 'EXILE_VOTE', 9); // god 1 down — badge-pass opens
    s = throughDawnBadgePass(s);
    expect(s.phase).toBe('night');
    s = runNight(s, { kill: 10 }); // god 2
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 11); // god 3 exiled — shot window
    s = apply(s, { type: 'HUNTER_PASS', actor: 11 });
    expect(s.phase).toBe('night');
    s = runNight(s, { kill: 12 }); // god 4 — 屠边 on gods
    expect(s.winner).toBe('wolves');
    expect(s.phase).toBe('game-over');
  });

  it('good wins when every wolf is dead', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', 1); // day 1: exile wolf 1
    expect(s.phase).toBe('night');
    s = runNight(s, { kill: 6, poison: 2 }); // night 2: knife + poison wolf 2
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 3); // day 2: exile wolf 3
    expect(s.phase).toBe('night');
    s = runNight(s, { kill: 7 }); // night 3: the knife (poison is spent)
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 4); // day 3: the last wolf falls — good wins
    expect(s.winner).toBe('good');
    expect(s.phase).toBe('game-over');
    expect(s.log.filter((e) => e.type === 'GAME_OVER')).toHaveLength(1);
  });

  it('when both sides are wiped in one step, good wins (wolves-dead is checked first)', () => {
    const s = baseGame();
    const probe = JSON.parse(JSON.stringify(s)) as ReturnType<typeof newGame>;
    for (const p of Object.values(probe.players)) {
      if (p.role === 'werewolf' || p.role === 'villager') p.alive = false;
    }
    // both 屠边 conditions hold (villagers gone) AND all wolves dead → good
    expect(winCheck(probe)).toBe('good');
    const oneWolfAlive = JSON.parse(JSON.stringify(probe)) as ReturnType<typeof newGame>;
    oneWolfAlive.players[4]!.alive = true;
    expect(winCheck(oneWolfAlive)).toBe('wolves');
  });

  it('a finished game rejects further actions', () => {
    let s = baseGame();
    s = voteAll(s, 'EXILE_VOTE', 1);
    s = runNight(s, { kill: 6, poison: 2 });
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 3);
    s = runNight(s, { kill: 7 });
    s = openDay(s);
    s = voteAll(s, 'EXILE_VOTE', 4);
    expect(s.phase).toBe('game-over');
    expectGameError(s, { type: 'PROCEED' }, 'WRONG_PHASE');
    expectGameError(s, { type: 'WOLF_KILL', actor: 8, target: 10 }, 'WRONG_PHASE');
  });
});

/** After exiling the sheriff: pass the badge interrupt (destroy) and reach night. */
function throughDawnBadgePass(state: ReturnType<typeof newGame>) {
  let s = state;
  expect(s.phase).toBe('badge-pass');
  s = apply(s, { type: 'SHERIFF_PASS', actor: 9, target: null }); // 撕毁
  return s;
}
