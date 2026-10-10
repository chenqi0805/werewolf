import { describe, expect, it } from 'vitest';

import { loadStoredName, saveStoredName } from './nameCache';

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

describe('name cache', () => {
  it('round-trips a name through storage', () => {
    const storage = memoryStorage();
    saveStoredName(storage, '阿明');
    expect(loadStoredName(storage)).toBe('阿明');
  });

  it('prefills empty when nothing is stored yet', () => {
    expect(loadStoredName(memoryStorage())).toBe('');
  });

  it('overwrites the previous name', () => {
    const storage = memoryStorage();
    saveStoredName(storage, '阿明');
    saveStoredName(storage, '小七');
    expect(loadStoredName(storage)).toBe('小七');
  });
});
