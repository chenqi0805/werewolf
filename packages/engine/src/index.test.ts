import { describe, expect, it } from 'vitest';

import { formatMeta, packageMeta } from './index';

describe('@werewolf/engine scaffold shell', () => {
  it('describes the package', () => {
    expect(formatMeta(packageMeta)).toBe('@werewolf/engine@0.0.0');
  });
});
