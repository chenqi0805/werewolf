import { describe, expect, it } from 'vitest';
import { makeRoomCode, makeToken } from '../ids';

describe('makeRoomCode', () => {
  it('uses four characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(makeRoomCode(new Set())).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it('never repeats a taken code', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const code = makeRoomCode(taken);
      expect(taken.has(code)).toBe(false);
      taken.add(code);
    }
  });
});

describe('makeToken', () => {
  it('generates unique opaque tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(makeToken());
    expect(tokens.size).toBe(100);
  });
});
