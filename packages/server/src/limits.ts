/**
 * Resource bounds for the unauthenticated room API (audit finding F2):
 * per-IP attempt limits for room:create / room:join, a global ceiling on
 * live lobbies, and a TTL for empty ones. No runtime dependencies — the
 * limiter is a fixed-window counter holding two numbers per IP.
 *
 * Every number is overridable through one WEREWOLF_LIMITS JSON env seam,
 * parsed in the same fail-loudly-at-boot style as WEREWOLF_TIMERS, so a
 * deployment tunes the bounds without code edits and a bad config cannot
 * start silently unbounded.
 */

/** The enforced bounds. `windowMs` is the width shared by both per-IP buckets. */
export interface Limits {
  /** room:create attempts allowed per IP per window. */
  createPerWindow: number;
  /**
   * room:join attempts allowed per IP per window. Failed lookups spend the
   * same budget as real joins — that spend is what deflates the
   * room-existence oracle (F9) to noise.
   */
  joinPerWindow: number;
  /** Width of the per-IP fixed window, in ms. */
  windowMs: number;
  /** Global ceiling on rooms with at least one connected socket. */
  maxLiveRooms: number;
  /** How long a room with zero connected sockets survives, in ms. */
  emptyLobbyTtlMs: number;
}

/**
 * The locked F2 numbers — deliberately generous enough that a family or
 * friend group sharing one NAT IP creating several rooms in an evening
 * never trips a limiter.
 */
export const DEFAULT_LIMITS: Limits = {
  createPerWindow: 10,
  joinPerWindow: 30,
  windowMs: 10 * 60_000,
  maxLiveRooms: 200,
  emptyLobbyTtlMs: 30 * 60_000,
};

/** Partial limit overrides — the shape WEREWOLF_LIMITS and tests pass in. */
export type LimitOverrides = Partial<Limits>;

/**
 * Fixed-window per-key counter: `max` attempts per `windowMs`, then reject
 * until the window rolls. Chosen over a sliding limiter because the seam
 * only promises bounded attempt volume — this holds two numbers per key,
 * prunes nothing, and resets lazily on the first attempt past the window.
 * `now` is injectable so tests can roll windows without fake timers.
 */
export class IpWindowLimiter {
  private readonly buckets = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts the attempt and answers whether it is within budget. */
  allow(key: string, now: number = Date.now()): boolean {
    const entry = this.buckets.get(key);
    if (entry === undefined || now - entry.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }
}

/**
 * WEREWOLF_LIMITS is a flat JSON object of number overrides (e.g.
 * `{"createPerWindow":3}`). Omitted keys keep the defaults. Unknown keys
 * are rejected — a typo must not silently leave the default in force while
 * an operator believes they tightened a limit. Operator errors fail loudly
 * at boot rather than silently racing a live room, the WEREWOLF_TIMERS
 * contract.
 */
export function parseLimits(raw: string | undefined): LimitOverrides | null {
  if (raw === undefined || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`WEREWOLF_LIMITS is not valid JSON: ${String(error)}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('WEREWOLF_LIMITS must be a JSON object of limit overrides.');
  }
  const out: LimitOverrides = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in DEFAULT_LIMITS)) {
      throw new Error(`WEREWOLF_LIMITS.${key} is not a known limit.`);
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !Number.isInteger(value)
    ) {
      throw new Error(`WEREWOLF_LIMITS.${key} must be a positive integer.`);
    }
    out[key as keyof Limits] = value;
  }
  return out;
}
