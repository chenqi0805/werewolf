/**
 * The player's identity across refreshes and reconnects: room code + seat +
 * session token, persisted per browser. Storage is injected so the logic
 * stays testable without a DOM.
 */

export interface GameSession {
  roomCode: string;
  seat: number;
  sessionToken: string;
}

const SESSION_KEY = 'werewolf-session';

export function loadSession(storage: Storage): GameSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { roomCode, seat, sessionToken } = parsed as Record<string, unknown>;
    if (typeof roomCode !== 'string' || roomCode.length === 0) return null;
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) return null;
    if (typeof seat !== 'number' || !Number.isInteger(seat)) return null;
    return { roomCode, seat, sessionToken };
  } catch {
    return null;
  }
}

export function saveSession(storage: Storage, session: GameSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(storage: Storage): void {
  storage.removeItem(SESSION_KEY);
}
