import { describe, expect, it } from 'vitest';

import { clearSession, loadSession, saveSession, type GameSession } from './session';

/** In-memory Storage stand-in — keeps these tests DOM-free. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => void map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

const session: GameSession = { roomCode: 'AB2C', seat: 7, sessionToken: 'tok-1' };

describe('session store', () => {
  it('round-trips a session through storage', () => {
    const storage = memoryStorage();
    saveSession(storage, session);
    expect(loadSession(storage)).toEqual(session);
  });

  it('returns null for an empty or corrupt store', () => {
    expect(loadSession(memoryStorage())).toBeNull();
    const corrupt = memoryStorage();
    corrupt.setItem('werewolf-session', '{not json');
    expect(loadSession(corrupt)).toBeNull();
    const wrongShape = memoryStorage();
    wrongShape.setItem('werewolf-session', JSON.stringify({ seat: 'seven' }));
    expect(loadSession(wrongShape)).toBeNull();
  });

  it('clears the stored session', () => {
    const storage = memoryStorage();
    saveSession(storage, session);
    clearSession(storage);
    expect(loadSession(storage)).toBeNull();
  });
});
