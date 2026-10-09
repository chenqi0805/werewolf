import { useCallback, useEffect, useReducer } from 'react';
import type { PlayerAction } from '@werewolf/engine';

import { initialGameStore, reduceGame, type GameStore } from './gameStore';
import { sendAction, type GameSocket } from './socketClient';
import { wireGameEvents } from './wireGameEvents';

/**
 * Live game state for the screens: subscribes to the socket, folds every
 * message through the pure store, and hands back a stable `send` for
 * PlayerActions. A null socket (still connecting) simply never receives.
 */
export function useGame(socket: GameSocket | null): {
  store: GameStore;
  send: (action: PlayerAction) => void;
} {
  const [store, dispatch] = useReducer(reduceGame, initialGameStore);

  useEffect(() => {
    if (socket === null) return undefined;
    return wireGameEvents(socket, { onMessage: dispatch });
  }, [socket]);

  const send = useCallback(
    (action: PlayerAction) => {
      if (socket !== null) sendAction(socket, action);
    },
    [socket],
  );

  return { store, send };
}
