/**
 * Placeholder entry point. The Socket.IO room server (rooms, session
 * tokens, phase timers, per-seat filtered views) lands in its own PR;
 * nothing here is transport or game logic.
 */
export interface PackageMeta {
  readonly name: string;
  readonly version: string;
}

export const packageMeta: PackageMeta = {
  name: '@werewolf/server',
  version: '0.0.0',
};

export function formatMeta(meta: PackageMeta): string {
  return `${meta.name}@${meta.version}`;
}
