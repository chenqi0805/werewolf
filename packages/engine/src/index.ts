/**
 * Placeholder entry point. The pure rules engine (roles, phases, and the
 * typed PlayerAction reducer) lands in its own PR; nothing here is game
 * logic — it only proves the package wiring end to end.
 */
export interface PackageMeta {
  readonly name: string;
  readonly version: string;
}

export const packageMeta: PackageMeta = {
  name: '@werewolf/engine',
  version: '0.0.0',
};

export function formatMeta(meta: PackageMeta): string {
  return `${meta.name}@${meta.version}`;
}
