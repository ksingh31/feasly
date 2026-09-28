import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from './app-config.defaults';

/**
 * Sheet-based finish-tier descriptors (budget-sheet reference): the wizard's
 * scope-step tier cards must carry the same buyer-grade descriptors as the
 * report page's tierDescriptors — Karan caught the wizard still showing the
 * old generic copy after #322 merged the descriptors into the report only.
 */
describe('wizard scopeTiers copy', () => {
  const tiers = DEFAULT_APP_CONFIG.copy.wizard.scopeTiers;
  const byId = Object.fromEntries(tiers.map((t) => [t.id, t.blurb]));

  it('has all three tiers', () => {
    expect(Object.keys(byId).sort()).toEqual(['luxury', 'premium', 'standard']);
  });

  it('standard: finishes never compromised, non-oak cabinetry, 9 ft ceilings', () => {
    expect(byId['standard']).toContain('never compromised');
    expect(byId['standard']).toContain('non-oak');
    expect(byId['standard']).toContain('9 ft');
  });

  it('premium: hardwood and tile, stone counters, designer fixtures', () => {
    expect(byId['premium']).toContain('hardwood and tile');
    expect(byId['premium']).toContain('stone counters');
    expect(byId['premium']).toContain('designer fixtures');
  });

  it('luxury: oak cabinetry, 10 ft ceilings, outdoor fireplace, feature walls, gym', () => {
    expect(byId['luxury']).toContain('Oak kitchen cabinetry');
    expect(byId['luxury']).toContain('10 ft ceilings');
    expect(byId['luxury']).toContain('outdoor fireplace');
    expect(byId['luxury']).toContain('feature walls');
    expect(byId['luxury']).toContain('gym');
  });

  it('carries no prices and no old generic copy', () => {
    for (const blurb of Object.values(byId)) {
      expect(blurb).not.toMatch(/\$\d/);
    }
    expect(byId['standard']).not.toContain('builder-grade');
    expect(byId['luxury']).not.toContain('Top shelf throughout');
  });
});
