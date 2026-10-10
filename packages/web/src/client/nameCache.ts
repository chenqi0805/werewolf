/**
 * The player's last-used display name, cached per browser so a returning
 * player pre-fills the connect form. Convenience only — identity remains
 * seat + token (see session.ts). Storage is injected so the logic stays
 * testable without a DOM.
 */

const NAME_KEY = 'werewolf:name';

/** The cached name, or '' when nothing is stored yet. */
export function loadStoredName(storage: Storage): string {
  return storage.getItem(NAME_KEY) ?? '';
}

/** Remember the name used at the door; overwrites any previous one. */
export function saveStoredName(storage: Storage, name: string): void {
  storage.setItem(NAME_KEY, name);
}
