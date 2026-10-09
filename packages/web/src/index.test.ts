import { describe, expect, it } from 'vitest';

import { greeting } from './index';

describe('@werewolf/web scaffold shell', () => {
  it('greets by name', () => {
    expect(greeting('Qi')).toBe('Welcome to werewolf-web, Qi');
  });
});
