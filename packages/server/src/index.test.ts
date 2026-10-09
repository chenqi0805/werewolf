import { describe, expect, it } from 'vitest';

import { formatMeta, packageMeta } from './index';

describe('@werewolf/server scaffold shell', () => {
  it('describes the package', () => {
    expect(formatMeta(packageMeta)).toBe('@werewolf/server@0.0.0');
  });
});
