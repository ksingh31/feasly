/**
 * SEO-04 spec: community cost-range build script.
 *
 * Fixture-based coverage for the frozen-engine range computation,
 * lot-size clamping, schema validation, deny-list scan, and the
 * prerender-routes refresh.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRangesFile,
  loadBuildSqft,
  rangesForCommunity,
  refreshPrerenderRoutes,
  writeRangesFile,
} from './build-community-ranges.js';
import {
  communityRangesFileSchema,
  scanDenyListRanges,
} from './community-ranges.schema.js';

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'community-ranges-'));
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('loadBuildSqft', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env['BUILD_SQFT'];
  });
  afterEach(() => {
    process.env = ENV;
  });

  it('defaults to 2400 sqft', () => {
    expect(loadBuildSqft()).toBe(2400);
  });

  it('reads BUILD_SQFT from the environment', () => {
    process.env['BUILD_SQFT'] = '2000';
    expect(loadBuildSqft()).toBe(2000);
  });

  it('rejects out-of-range values', () => {
    process.env['BUILD_SQFT'] = '100';
    expect(() => loadBuildSqft()).toThrow(/BUILD_SQFT/);
  });
});

describe('rangesForCommunity', () => {
  it('returns public range bands with fixed land (no spreads on land)', () => {
    const warnings: string[] = [];
    const { ranges, calibrated } = rangesForCommunity(600000, 5000, 'standard', 2400, (m) =>
      warnings.push(m),
    );
    expect(ranges.landValue).toBe(600000);
    expect(ranges.buildLow).toBeLessThanOrEqual(ranges.buildHigh);
    expect(ranges.totalLow).toBeLessThanOrEqual(ranges.totalHigh);
    // Total = land (fixed) + build (range).
    expect(ranges.totalLow).toBe(ranges.landValue + ranges.buildLow);
    expect(ranges.totalHigh).toBe(ranges.landValue + ranges.buildHigh);
    expect(typeof calibrated).toBe('boolean');
    expect(warnings).toHaveLength(0);
  });

  it('clamps oversized lots into engine bounds and warns', () => {
    const warnings: string[] = [];
    const { ranges } = rangesForCommunity(600000, 50000, 'standard', 2400, (m) =>
      warnings.push(m),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/clamped/);
    expect(ranges.landValue).toBe(600000);
  });

  it('prices all three tiers with increasing bands', () => {
    const warnings: string[] = [];
    const warn = (m: string): void => {
      warnings.push(m);
    };
    const s = rangesForCommunity(600000, 5000, 'standard', 2400, warn).ranges;
    const p = rangesForCommunity(600000, 5000, 'premium', 2400, warn).ranges;
    const l = rangesForCommunity(600000, 5000, 'luxury', 2400, warn).ranges;
    expect(s.buildLow).toBeLessThan(p.buildLow);
    expect(p.buildLow).toBeLessThan(l.buildLow);
  });

  it('is deterministic — same inputs, same outputs', () => {
    const a = rangesForCommunity(600000, 5000, 'premium', 2400).ranges;
    const b = rangesForCommunity(600000, 5000, 'premium', 2400).ranges;
    expect(a).toEqual(b);
  });
});

describe('writeRangesFile', () => {
  const file = {
    generatedAt: new Date().toISOString(),
    costDataVersion: 'v0.2.0-unclibrated',
    calibrated: false,
    buildSqft: 2400,
    communities: [
      {
        slug: 'beltline',
        tiers: {
          standard: { buildLow: 1, buildHigh: 2, landValue: 3, totalLow: 4, totalHigh: 5 },
          premium: { buildLow: 1, buildHigh: 2, landValue: 3, totalLow: 4, totalHigh: 5 },
          luxury: { buildLow: 1, buildHigh: 2, landValue: 3, totalLow: 4, totalHigh: 5 },
        },
      },
    ],
  };

  it('writes schema-valid JSON', () => {
    const out = join(workdir, 'community-ranges.json');
    writeRangesFile(file, out);
    const parsed = communityRangesFileSchema.safeParse(JSON.parse(readFileSync(out, 'utf8')));
    expect(parsed.success).toBe(true);
  });

  it('fails the build on deny-listed terms', () => {
    const sneaky = {
      ...file,
      communities: [
        {
          slug: 'beltline',
          tiers: {
            standard: { buildLow: 1, buildHigh: 2, landValue: 3, totalLow: 4, totalHigh: 5 },
            premium: { buildLow: 1, buildHigh: 2, landValue: 3, totalLow: 4, totalHigh: 5 },
            luxury: { buildLow: 1, buildHigh: 2, landValue: 3, totalLow: 4, totalHigh: 5 },
          },
        },
      ],
    };
    // Inject a deny-listed term via the version string.
    const bad = { ...sneaky, costDataVersion: 'v1-margin-test' };
    expect(() => writeRangesFile(bad, join(workdir, 'out.json'))).toThrow(/deny-list hit/);
  });
});

describe('scanDenyListRanges', () => {
  it('flags proprietary cost-model terms', () => {
    expect(scanDenyListRanges('{"per_sqft": 1}')).toContain('per_sqft');
    expect(scanDenyListRanges('{"margin": 0.2}')).toContain('margin');
  });

  it('passes the real artifact keys', () => {
    expect(
      scanDenyListRanges(
        JSON.stringify({
          generatedAt: '2026-09-24T00:00:00.000Z',
          costDataVersion: 'v0.2.0-unclibrated',
          calibrated: false,
          buildSqft: 2400,
          communities: [
            {
              slug: 'beltline',
              tiers: {
                standard: { buildLow: 1, buildHigh: 2, landValue: 3, totalLow: 4, totalHigh: 5 },
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('refreshPrerenderRoutes', () => {
  it('keeps hand-maintained routes and refreshes community routes', () => {
    const routesPath = join(workdir, 'prerender-routes.txt');
    writeFileSync(routesPath, '/\n/privacy\n/communities/stale-slug/\n');
    refreshPrerenderRoutes(['beltline', 'panorama-hills'], routesPath);
    const content = readFileSync(routesPath, 'utf8');
    expect(content).toContain('/\n');
    expect(content).toContain('/privacy\n');
    expect(content).not.toContain('stale-slug');
    expect(content).toContain('/communities/beltline/\n');
    expect(content).toContain('/communities/panorama-hills/\n');
  });

  it('preserves the /communities/ index route (SEO-05)', () => {
    const routesPath = join(workdir, 'prerender-routes.txt');
    writeFileSync(routesPath, '/\n/communities/\n/communities/stale-slug/\n');
    refreshPrerenderRoutes(['beltline'], routesPath);
    const content = readFileSync(routesPath, 'utf8');
    expect(content).toContain('/communities/\n');
    expect(content).not.toContain('stale-slug');
    expect(content).toContain('/communities/beltline/\n');
    // Index route appears exactly once (not duplicated on re-runs).
    expect(content.match(/^\/communities\/$/gm)?.length).toBe(1);
  });
});
