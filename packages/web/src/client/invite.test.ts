import { describe, expect, it } from 'vitest';

import { isValidInviteEmail, roomCodeFromUrl } from './invite';

describe('isValidInviteEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidInviteEmail('friend@example.com')).toBe(true);
  });

  it('rejects the obvious mistakes the server refuses', () => {
    expect(isValidInviteEmail('')).toBe(false);
    expect(isValidInviteEmail('no-at-sign')).toBe(false);
    expect(isValidInviteEmail('two@at@signs')).toBe(false);
    expect(isValidInviteEmail('missing-domain@')).toBe(false);
    expect(isValidInviteEmail('no-tld@example')).toBe(false);
    expect(isValidInviteEmail('space in@example.com')).toBe(false);
  });

  it('holds the same RFC length ceiling as the server', () => {
    const domain = '@example.com';
    expect(isValidInviteEmail('a'.repeat(254 - domain.length) + domain)).toBe(true);
    expect(isValidInviteEmail('a'.repeat(255 - domain.length) + domain)).toBe(false);
  });
});

describe('roomCodeFromUrl', () => {
  it('reads the room param from an invite link', () => {
    expect(roomCodeFromUrl('?room=AB2C')).toBe('AB2C');
    expect(roomCodeFromUrl('?room=AB2C&utm_source=email')).toBe('AB2C');
  });

  it('returns empty when no usable code is present', () => {
    expect(roomCodeFromUrl('')).toBe('');
    expect(roomCodeFromUrl('?other=1')).toBe('');
    expect(roomCodeFromUrl('?room=%20%20')).toBe('');
  });

  it('trims whitespace and caps at the input ceiling', () => {
    expect(roomCodeFromUrl('?room=%20AB2C%20')).toBe('AB2C');
    expect(roomCodeFromUrl('?room=ABCDEFGH')).toBe('ABCDEFGH');
    expect(roomCodeFromUrl('?room=ABCDEFGHI')).toBe('ABCDEFGH');
  });
});
