import { describe, expect, it } from 'vitest';

import { BOARD_OPTIONS, type BoardOption } from './boardOptions';

function optionOf(id: 'classic' | 'wolfking'): BoardOption {
  const option = BOARD_OPTIONS.find((o) => o.id === id);
  if (option === undefined) throw new Error(`missing board option: ${id}`);
  return option;
}

describe('BOARD_OPTIONS', () => {
  it('offers both shipped boards in registry order', () => {
    expect(BOARD_OPTIONS.map((o) => o.id)).toEqual(['classic', 'wolfking']);
    expect(optionOf('classic').name).toBe('标准局 · 预女猎白');
    expect(optionOf('wolfking').name).toBe('白狼王局 · 预女猎守');
  });

  it('previews the classic lineup without the wolfking roles', () => {
    const classic = optionOf('classic').lineup;
    expect(classic).toContain('狼人×4');
    expect(classic).toContain('白痴');
    expect(classic).not.toContain('守卫');
    expect(classic).not.toContain('白狼王');
  });

  it('previews the wolfking lineup with the guard and the king', () => {
    const wolfking = optionOf('wolfking').lineup;
    expect(wolfking).toContain('狼人×3');
    expect(wolfking).toContain('白狼王');
    expect(wolfking).toContain('守卫');
    expect(wolfking).toContain('村民×4');
    expect(wolfking).not.toContain('白痴');
  });
});
