import { expect, test } from '@playwright/test';

import { playScriptedGame } from './harness/driver';
import { wolfKingPlan } from './harness/plans';
import { dayLogText, revealFates } from './harness/reveal';
import { openTable, anchorPage } from './harness/table';

/** Evidence directory for game-over screenshots (CI artifact / QA upload). */
const EVIDENCE_DIR = process.env.WEREWOLF_EVIDENCE_DIR;

test('scenario C: 预女猎守 — guard save, 白狼王 destruct, taken hunter shot', async ({
  browser,
}) => {
  const table = await openTable(browser, { board: 'wolfking' });
  try {
    const roles = new Map(table.seats.map((seat) => [seat.seat, seat.role]));
    expect(
      [...roles.values()].filter((role) => role === 'white_wolf_king'),
      'exactly one 白狼王 dealt',
    ).toHaveLength(1);

    const winner = await playScriptedGame(table, wolfKingPlan(roles), {
      label: 'wolfking-win',
      evidenceDir: EVIDENCE_DIR,
    });
    expect(winner).toBe('good');

    const log = await dayLogText(anchorPage(table));
    expect(log, 'night 1 is a peaceful night — the guard save').toContain('平安夜');
    expect(log, 'the king self-destructs in the day log').toContain('自爆，带走了');
    expect(log, 'the taken hunter still shoots').toContain('猎人开枪带走了');

    const fates = await revealFates(anchorPage(table));
    const villagers = [...roles.entries()]
      .filter(([, role]) => role === 'villager')
      .map(([seat]) => seat)
      .sort((a, b) => a - b);
    for (const [seat, role] of roles) {
      expect(fates.get(seat), `seat ${seat} (${role}) reveal row`).toBeDefined();
      // The script's deterministic dead set: the king, the taken hunter, the
      // shot wolf, both exiled wolves, and the two knifed villagers.
      if (role === 'white_wolf_king' || role === 'hunter' || role === 'werewolf') {
        expect(fates.get(seat), `seat ${seat} (${role})`).toBe('出局');
      }
    }
    if (villagers[0] !== undefined) expect(fates.get(villagers[0])).toBe('出局');
    if (villagers[1] !== undefined) expect(fates.get(villagers[1])).toBe('出局');
    for (const seat of villagers.slice(2)) {
      expect(fates.get(seat), `surviving villager ${seat}`).toBe('存活');
    }
    for (const seat of [...roles.entries()].filter(([, role]) => role === 'guard')) {
      expect(fates.get(seat[0]), 'the guard survives — the knife never comes for him').toBe('存活');
    }
  } finally {
    await table.close();
  }
});
