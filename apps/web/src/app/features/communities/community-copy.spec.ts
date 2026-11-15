import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { DEFAULT_COMMUNITY_PROFILE_COPY } from './community-profile-copy.defaults';

/**
 * Consumer review S8 / P5 (2026-11-13): community pages describe a
 * community, not a single property, and share the site-wide
 * "Feasly — …" title format.
 */
describe('community page copy', () => {
  const guideCopy = DEFAULT_APP_CONFIG.copy.communities;

  it('never says "this property" on community pages (S8)', () => {
    expect(JSON.stringify(DEFAULT_COMMUNITY_PROFILE_COPY)).not.toMatch(/this property/i);
    expect(JSON.stringify(guideCopy)).not.toMatch(/this property/i);
  });

  it('uses the "Feasly — …" title format for both variants (P5)', () => {
    expect(DEFAULT_COMMUNITY_PROFILE_COPY.titleTemplate).toMatch(/^Feasly — /);
    expect(DEFAULT_COMMUNITY_PROFILE_COPY.titleTemplate).not.toContain('| Feasly');
    expect(guideCopy.titleTemplate).toMatch(/^Feasly — /);
  });
});
