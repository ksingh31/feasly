/**
 * #752 tripwire: every visitor-facing property read goes through our API
 * (owner decision 2026-11-15). The served config and the compiled default
 * both select the `backend` property source, so neither a deploy nor a
 * failed config load sends visitors' browsers to the City API directly.
 * `live` stays selectable for local development only.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from './app-config.defaults';

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/src/app/core/config -> apps/web/public/assets/config/app-config.json
const SERVED_CONFIG = join(here, '..', '..', '..', '..', 'public', 'assets', 'config', 'app-config.json');

describe('property data source (#752)', () => {
  it('the served config reads property data from our API', () => {
    const served = JSON.parse(readFileSync(SERVED_CONFIG, 'utf8')) as {
      propertyData?: { source?: string };
    };
    expect(served.propertyData?.source).toBe('backend');
  });

  it('the compiled default reads property data from our API', () => {
    expect(DEFAULT_APP_CONFIG.propertyData.source).toBe('backend');
  });
});
