import type { GameEvent } from '@werewolf/engine';
import type { ErrorPayload, PlayerView } from '@werewolf/server';

import type { GameStoreMessage } from './gameStore';
import type { GameSocket } from './socketClient';

export interface GameEventHandlers {
  onMessage: (message: GameStoreMessage) => void;
}

/**
 * Registers every server → client listener and folds the payloads into
 * store messages. Returns a disposer for the hook's cleanup.
 */
export function wireGameEvents(socket: GameSocket, handlers: GameEventHandlers): () => void {
  const onView = (view: PlayerView) => handlers.onMessage({ kind: 'view', view });
  const onEvent = (event: GameEvent) => handlers.onMessage({ kind: 'event', event });
  const onError = (payload: ErrorPayload) =>
    handlers.onMessage({ kind: 'error', code: payload.code, message: payload.message });

  socket.on('game:view', onView);
  socket.on('game:event', onEvent);
  socket.on('game:error', onError);

  return () => {
    socket.off('game:view', onView);
    socket.off('game:event', onEvent);
    socket.off('game:error', onError);
  };
}
