import type { GameEvent } from '@werewolf/engine';
import type { PlayerView } from '@werewolf/server';

/**
 * Pure reducer for the live game client: socket messages in, UI state out.
 * The React hook (`useGame`) is a thin wrapper around this — everything
 * testable lives here.
 */
export type GameStoreMessage =
  /** The server's filtered snapshot, already carrying the room's step deadline. */
  | { kind: 'view'; view: PlayerView }
  /** One visibility-filtered event, private or public. */
  | { kind: 'event'; event: GameEvent }
  /** A per-socket rejection from the server. */
  | { kind: 'error'; code: string; message: string }
  /** The stored session token no longer attaches to a seat. */
  | { kind: 'session-lost'; reason: string }
  /** Back to square one (left the room / cleared session). */
  | { kind: 'reset' };

export interface GameStore {
  view: PlayerView | null;
  /** Latest event received — public notices and private results alike. */
  lastEvent: GameEvent | null;
  /** Latest rejection; cleared by the next accepted view. */
  lastError: { code: string; message: string } | null;
  /** Why the stored session was rejected, if it was. */
  sessionLost: string | null;
}

export const initialGameStore: GameStore = {
  view: null,
  lastEvent: null,
  lastError: null,
  sessionLost: null,
};

export function reduceGame(store: GameStore, message: GameStoreMessage): GameStore {
  switch (message.kind) {
    case 'view':
      // An accepted change means the last rejection is stale.
      return { ...store, view: message.view, lastError: null };
    case 'event':
      return { ...store, lastEvent: message.event };
    case 'error':
      return { ...store, lastError: { code: message.code, message: message.message } };
    case 'session-lost':
      return { ...store, sessionLost: message.reason };
    case 'reset':
      return initialGameStore;
  }
}
