import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import backdropUrl from '../../assets/night-village.webp';
import { NightVillageBackground } from './NightVillageBackground';
import styles from './NightVillageBackground.module.css';

describe('NightVillageBackground', () => {
  it('renders a decorative art layer with the scrim and the village asset', () => {
    const markup = renderToStaticMarkup(<NightVillageBackground />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(`src="${backdropUrl}"`);
    expect(markup).toContain('alt=""');
    expect(markup).toContain(styles.backdrop);
    expect(markup).toContain(styles.image);
    expect(markup).toContain(styles.scrim);
  });

  it('keeps the village asset under the 500 KB bundle budget', () => {
    const assetPath = new URL('../../assets/night-village.webp', import.meta.url);
    expect(readFileSync(assetPath).byteLength).toBeLessThanOrEqual(500 * 1024);
  });
});
