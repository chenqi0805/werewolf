import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, IpWindowLimiter, parseLimits } from '../limits';
import { RoomRegistry } from '../room';

describe('DEFAULT_LIMITS', () => {
  // The locked F2 numbers, pinned so an accidental edit fails here instead
  // of silently retuning the deployment.
  it('carries the spec numbers', () => {
    expect(DEFAULT_LIMITS).toEqual({
      createPerWindow: 10,
      joinPerWindow: 30,
      windowMs: 10 * 60_000,
      maxLiveRooms: 200,
      emptyLobbyTtlMs: 30 * 60_000,
    });
  });
});

describe('IpWindowLimiter', () => {
  it('allows exactly max attempts, then rejects until the window rolls', () => {
    const limiter = new IpWindowLimiter(3, 1_000);
    const t0 = 100_000;
    expect(limiter.allow('ip', t0)).toBe(true);
    expect(limiter.allow('ip', t0 + 1)).toBe(true);
    expect(limiter.allow('ip', t0 + 2)).toBe(true);
    expect(limiter.allow('ip', t0 + 3)).toBe(false);
    // The window rolls from its start, not from the last attempt.
    expect(limiter.allow('ip', t0 + 999)).toBe(false);
    expect(limiter.allow('ip', t0 + 1_000)).toBe(true);
  });

  it('keys budgets per IP — exhausting one leaves another fresh', () => {
    const limiter = new IpWindowLimiter(1, 1_000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 1)).toBe(false);
    expect(limiter.allow('b', 1)).toBe(true);
  });
});

describe('parseLimits (the WEREWOLF_LIMITS seam)', () => {
  it('reads unset and empty as no overrides', () => {
    expect(parseLimits(undefined)).toBeNull();
    expect(parseLimits('')).toBeNull();
  });

  it('parses a full override object', () => {
    expect(
      parseLimits(
        JSON.stringify({
          createPerWindow: 3,
          joinPerWindow: 7,
          windowMs: 5000,
          maxLiveRooms: 20,
          emptyLobbyTtlMs: 1000,
        }),
      ),
    ).toEqual({
      createPerWindow: 3,
      joinPerWindow: 7,
      windowMs: 5000,
      maxLiveRooms: 20,
      emptyLobbyTtlMs: 1000,
    });
  });

  it('parses a partial override, leaving omitted keys at defaults', () => {
    expect(parseLimits('{"createPerWindow":2}')).toEqual({ createPerWindow: 2 });
  });

  it('fails loudly on garbage JSON', () => {
    expect(() => parseLimits('{oops')).toThrow(/not valid JSON/);
  });

  it('fails loudly on non-object JSON', () => {
    expect(() => parseLimits('[1]')).toThrow(/JSON object/);
  });

  it('fails loudly on unknown keys — a typo must not silently keep the default', () => {
    expect(() => parseLimits('{"createPerwindow":5}')).toThrow(/not a known limit/);
  });

  it('fails loudly on non-positive or non-integer values', () => {
    for (const bad of [
      '{"createPerWindow":0}',
      '{"createPerWindow":-1}',
      '{"createPerWindow":1.5}',
      '{"maxLiveRooms":"many"}',
    ]) {
      expect(() => parseLimits(bad)).toThrow(/positive integer/);
    }
  });
});

describe('RoomRegistry.remove', () => {
  it('drops the room and retires its code', () => {
    const registry = new RoomRegistry();
    const room = registry.create();
    expect(registry.get(room.code)).toBeDefined();
    registry.remove(room.code);
    expect(registry.get(room.code)).toBeUndefined();
  });
});
