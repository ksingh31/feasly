/**
 * SEO-03 / #690 spec: community data build script.
 *
 * Fixture-based coverage for the config-driven selection (rule + include +
 * exclude + top-N + min-records), residential-only averages, the Socrata
 * fetchers, slug uniqueness/collision, zod validation, deny-list scan, and
 * the 30-day staleness guard.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ageInDays,
  cachedSelectionHash,
  fetchBoundaries,
  fetchResidentialAggregates,
  latestRollYear,
  loadConfig,
  selectCommunities,
  slugify,
  writeAggregates,
} from './build-community-data.js';
import type { BoundaryRow, RawAggregateRow } from './build-community-data.js';
import {
  communityAggregatesFileSchema,
  scanDenyList,
} from './community-aggregates.schema.js';
import type { CommunityAggregate } from './community-aggregates.schema.js';
import { loadCitySelection } from './community-selection.schema.js';
import type { CitySelection } from './community-selection.schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const BASE_SELECTION: CitySelection = {
  socrataBaseUrl: 'https://data.calgary.ca',
  assessmentDataset: '4bsw-nn7w',
  boundariesDataset: 'surr-xmvs',
  rule: { classes: ['Residential'], structures: ['INNER CITY', '1950s'] },
  include: [],
  exclude: [],
  topByCount: 0,
  minRecords: 100,
  guide: { subPropertyUses: ['R110', 'R111', 'R120', 'R121'], minRecords: 50 },
  establishedStructures: ['CENTRE CITY', 'INNER CITY', '1950s'],
  profileOverrides: [],
};

const BOUNDARIES: BoundaryRow[] = [
  { name: 'ALTADORE', communityClass: 'Residential', structure: 'INNER CITY', sector: 'CENTRE' },
  { name: 'KILLARNEY/GLENGARRY', communityClass: 'Residential', structure: '1950s', sector: 'CENTRE' },
  { name: 'PANORAMA HILLS', communityClass: 'Residential', structure: '1980s/1990s', sector: 'NORTH' },
  { name: 'DOWNTOWN COMMERCIAL CORE', communityClass: 'Residential', structure: 'CENTRE CITY', sector: 'CENTRE' },
  { name: 'MANCHESTER INDUSTRIAL', communityClass: 'Industrial', structure: 'INNER CITY', sector: 'CENTRE' },
  { name: 'TINY PLACE', communityClass: 'Residential', structure: 'INNER CITY', sector: 'CENTRE' },
];

/** All residential dwellings (condos included). */
const RESIDENTIAL: RawAggregateRow[] = [
  { commName: 'PANORAMA HILLS', count: '8109', avgAssessedValue: '650000.4', avgLotSqft: '9000' },
  { commName: 'ALTADORE', count: '3100', avgAssessedValue: '980000.6', avgLotSqft: '8000' },
  { commName: 'KILLARNEY/GLENGARRY', count: '3500', avgAssessedValue: '700000', avgLotSqft: '7000' },
  { commName: 'DOWNTOWN COMMERCIAL CORE', count: '2196', avgAssessedValue: '420000', avgLotSqft: '60000' },
  { commName: 'MANCHESTER INDUSTRIAL', count: '400', avgAssessedValue: '300000', avgLotSqft: '5000' },
  { commName: 'TINY PLACE', count: '12', avgAssessedValue: '500000', avgLotSqft: '5000' },
];

/** Single-detached + semi-detached homes only. */
const GUIDE: RawAggregateRow[] = [
  { commName: 'PANORAMA HILLS', count: '5983', avgAssessedValue: '764928.04', avgLotSqft: '4684.56' },
  { commName: 'ALTADORE', count: '2044', avgAssessedValue: '1303427.8', avgLotSqft: '4271.6' },
  { commName: 'KILLARNEY/GLENGARRY', count: '2093', avgAssessedValue: '890476.6', avgLotSqft: '4203.7' },
];

function select(selection: Partial<CitySelection> = {}, warnings: string[] = []): CommunityAggregate[] {
  return selectCommunities({ ...BASE_SELECTION, ...selection }, BOUNDARIES, RESIDENTIAL, GUIDE, (m) =>
    warnings.push(m),
  );
}

function stubFetch(body: unknown, ok = true, status = 200, urls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    urls.push(String(input));
    return { ok, status, json: async () => body } as Response;
  }) as typeof fetch;
}

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'community-data-'));
});

// ---------------------------------------------------------------------------
// Selection config (checked-in file)
// ---------------------------------------------------------------------------
describe('community-selection.json', () => {
  const { selection } = loadCitySelection(undefined, undefined);

  it('loads and validates the default city', () => {
    expect(selection.boundariesDataset).toBe('surr-xmvs');
    expect(selection.rule.structures).toEqual(['INNER CITY', '1950s', '1960s/1970s']);
  });

  it('keeps every previously indexed community on the include list (no new 404s)', () => {
    // The 40 pages that existed before #690 (top-40 by record count).
    const previouslyIndexed = [
      'beltline', 'panorama-hills', 'cranston', 'saddle-ridge', 'mahogany', 'mckenzie-towne',
      'evergreen', 'tuscany', 'sage-hill', 'auburn-bay', 'skyview-ranch', 'evanston', 'copperfield',
      'signal-hill', 'legacy', 'seton', 'varsity', 'cornerstone', 'west-springs', 'springbank-hill',
      'douglasdale-glen', 'coventry-hills', 'edgemont', 'royal-oak', 'lake-bonavista',
      'huntington-hills', 'bridlewood', 'mckenzie-lake', 'livingston', 'taradale', 'chaparral',
      'arbour-lake', 'new-brighton', 'beddington-heights', 'bowness', 'dover', 'rocky-ridge',
      'bridgeland-riverside', 'downtown-commercial-core', 'walden',
    ];
    const included = new Set(selection.include.map(slugify));
    for (const slug of previouslyIndexed) expect(included, slug).toContain(slug);
    expect(selection.exclude.map(slugify).filter((s) => previouslyIndexed.includes(s))).toEqual([]);
  });

  it('rejects an unknown city', () => {
    expect(() => loadCitySelection(undefined, 'edmonton')).toThrow(/no config for city/);
  });

  it('rejects a malformed config file', () => {
    const bad = join(workdir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ defaultCity: 'calgary', cities: { calgary: { rule: {} } } }));
    expect(() => loadCitySelection(bad, undefined)).toThrow(/invalid config/);
  });

  it('loadConfig hashes the selection so a config edit invalidates the cache', () => {
    const a = join(workdir, 'a.json');
    const b = join(workdir, 'b.json');
    writeFileSync(a, JSON.stringify({ defaultCity: 'calgary', cities: { calgary: BASE_SELECTION } }));
    writeFileSync(
      b,
      JSON.stringify({ defaultCity: 'calgary', cities: { calgary: { ...BASE_SELECTION, exclude: ['ALTADORE'] } } }),
    );
    expect(loadConfig([], a).selectionHash).not.toBe(loadConfig([], b).selectionHash);
    expect(loadConfig([], a).selectionHash).toBe(loadConfig([], a).selectionHash);
    expect(loadConfig(['--force'], a).force).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectCommunities — the list comes from config, not code (#690 AC2)
// ---------------------------------------------------------------------------
describe('selectCommunities', () => {
  it('selects residential communities whose structure matches the rule', () => {
    const warnings: string[] = [];
    const slugs = select({}, warnings).map((c) => c.slug);
    expect(slugs).toEqual(['killarney-glengarry', 'altadore']);
    // Industrial class is not a rule match; the tiny community is below minRecords.
    expect(slugs).not.toContain('manchester-industrial');
    expect(warnings.some((w) => w.includes('TINY PLACE') && w.includes('no page'))).toBe(true);
  });

  it('changing the config changes the list — no code change', () => {
    expect(select({ rule: { classes: ['Residential'], structures: ['INNER CITY'] } }).map((c) => c.slug)).toEqual([
      'altadore',
    ]);
    expect(select({ include: ['PANORAMA HILLS'] }).map((c) => c.slug)).toEqual([
      'panorama-hills',
      'killarney-glengarry',
      'altadore',
    ]);
    expect(select({ exclude: ['ALTADORE'] }).map((c) => c.slug)).toEqual(['killarney-glengarry']);
    expect(select({ topByCount: 1 }).map((c) => c.slug)).toContain('panorama-hills');
    expect(select({ minRecords: 3200 }).map((c) => c.slug)).toEqual(['killarney-glengarry']);
    expect(select({ minRecords: 10 }).map((c) => c.slug)).toContain('tiny-place');
  });

  it('exclude wins over include and the rule', () => {
    const slugs = select({ include: ['ALTADORE'], exclude: ['altadore'] }).map((c) => c.slug);
    expect(slugs).not.toContain('altadore');
  });

  it('warns when an included community has too few records', () => {
    const warnings: string[] = [];
    select({ include: ['NOWHERE'] }, warnings);
    expect(warnings.some((w) => w.includes('NOWHERE') && w.includes('include list'))).toBe(true);
  });

  it('guide averages use single/semi-detached records only (#690 AC3)', () => {
    const altadore = select().find((c) => c.slug === 'altadore');
    expect(altadore).toMatchObject({
      basis: 'detached-semi',
      count: 2044,
      avgAssessedValue: 1303428,
      avgLotSqft: 4272,
      residential: { count: 3100, avgAssessedValue: 980001, avgLotSqft: 8000 },
    });
  });

  it('falls back to residential averages (profile-only) when a community has too few houses', () => {
    const downtown = select({ include: ['DOWNTOWN COMMERCIAL CORE'] }).find(
      (c) => c.slug === 'downtown-commercial-core',
    );
    expect(downtown).toMatchObject({ basis: 'residential', count: 2196, avgAssessedValue: 420000 });
    const fewHouses = select({ guide: { subPropertyUses: ['R110'], minRecords: 2050 } });
    expect(fewHouses.find((c) => c.slug === 'altadore')?.basis).toBe('residential');
    expect(fewHouses.find((c) => c.slug === 'killarney-glengarry')?.basis).toBe('detached-semi');
  });

  it('groups by community structure and carries the sector', () => {
    const list = select({ include: ['PANORAMA HILLS', 'DOWNTOWN COMMERCIAL CORE'] });
    const bySlug = new Map(list.map((c) => [c.slug, c]));
    expect(bySlug.get('altadore')).toMatchObject({ group: 'established', sector: 'CENTRE' });
    expect(bySlug.get('downtown-commercial-core')?.group).toBe('established');
    expect(bySlug.get('panorama-hills')).toMatchObject({ group: 'newer', sector: 'NORTH' });
  });

  it('matches names case-insensitively', () => {
    expect(select({ include: ['panorama hills'] }).map((c) => c.slug)).toContain('panorama-hills');
  });

  it('disambiguates slug collisions and logs them', () => {
    const warnings: string[] = [];
    const result = selectCommunities(
      { ...BASE_SELECTION, include: ['FOO BAR', 'FOO-BAR'] },
      [],
      [
        { commName: 'FOO BAR', count: 200, avgAssessedValue: 100, avgLotSqft: 100 },
        { commName: 'FOO-BAR', count: 190, avgAssessedValue: 100, avgLotSqft: 100 },
      ],
      [],
      (m) => warnings.push(m),
    );
    expect(result.map((r) => r.slug)).toEqual(['foo-bar', 'foo-bar-2']);
    expect(warnings.filter((w) => /slug collision/.test(w))).toHaveLength(1);
  });

  it('drops rows with unusable figures', () => {
    const result = selectCommunities(
      { ...BASE_SELECTION, include: ['BROKEN'] },
      [],
      [{ commName: 'BROKEN', count: '500', avgAssessedValue: null, avgLotSqft: '1' }],
      [],
      () => undefined,
    );
    expect(result).toEqual([]);
  });
});

describe('slugify', () => {
  it('converts City names to kebab-case', () => {
    expect(slugify('PANORAMA HILLS')).toBe('panorama-hills');
    expect(slugify('KILLARNEY/GLENGARRY')).toBe('killarney-glengarry');
    expect(slugify('  Beltline  ')).toBe('beltline');
  });
});

// ---------------------------------------------------------------------------
// Socrata fetchers (fixture-based)
// ---------------------------------------------------------------------------
describe('Socrata fetchers', () => {
  const cfg = {
    socrataBaseUrl: 'https://data.calgary.ca',
    socrataDataset: '4bsw-nn7w',
    boundariesDataset: 'surr-xmvs',
  };

  it('reads the latest roll year', async () => {
    expect(await latestRollYear(cfg, stubFetch([{ roll_year: '2026' }]))).toBe('2026');
    await expect(latestRollYear(cfg, stubFetch([]))).rejects.toThrow(/roll_year/);
  });

  it('maps boundary rows and drops nameless ones', async () => {
    const rows = await fetchBoundaries(
      cfg,
      stubFetch([
        { name: 'ALTADORE', class: 'Residential', comm_structure: 'INNER CITY', sector: 'CENTRE' },
        { class: 'Industrial' },
      ]),
    );
    expect(rows).toEqual([
      { name: 'ALTADORE', communityClass: 'Residential', structure: 'INNER CITY', sector: 'CENTRE' },
    ]);
  });

  it('filters guide aggregates to the configured sub_property_use codes', async () => {
    const urls: string[] = [];
    const rows = await fetchResidentialAggregates(
      cfg,
      '2026',
      ['R110', 'R120'],
      stubFetch([{ comm_name: 'ALTADORE', count: '2044', avg_assessed_value: '1', avg_land_size_sf: '2' }], true, 200, urls),
    );
    expect(rows[0]).toMatchObject({ commName: 'ALTADORE', count: '2044' });
    const where = new URL(urls[0] ?? '').searchParams.get('$where') ?? '';
    expect(where).toContain("assessment_class='RE'");
    expect(where).toContain("sub_property_use in('R110','R120')");
  });

  it('residential aggregates exclude A-codes (common elements, parking, storage)', async () => {
    const urls: string[] = [];
    await fetchResidentialAggregates(cfg, '2026', undefined, stubFetch([], true, 200, urls));
    expect(new URL(urls[0] ?? '').searchParams.get('$where')).toContain("NOT starts_with(sub_property_use, 'A')");
  });

  it('rejects unsafe codes and roll years before building a query', async () => {
    await expect(fetchResidentialAggregates(cfg, '2026', ["R110') OR ('1"], stubFetch([]))).rejects.toThrow(
      /invalid sub_property_use/,
    );
    await expect(fetchResidentialAggregates(cfg, "2026' OR '1", undefined, stubFetch([]))).rejects.toThrow(
      /invalid roll year/,
    );
  });

  it('throws on a non-OK response', async () => {
    await expect(fetchBoundaries(cfg, stubFetch([], false, 429))).rejects.toThrow(/HTTP 429/);
  });
});

// ---------------------------------------------------------------------------
// writeAggregates + schema + deny-list
// ---------------------------------------------------------------------------
const ROW: CommunityAggregate = {
  slug: 'altadore',
  name: 'ALTADORE',
  count: 2044,
  avgAssessedValue: 1303428,
  avgLotSqft: 4272,
  basis: 'detached-semi',
  group: 'established',
  sector: 'CENTRE',
  residential: { count: 3100, avgAssessedValue: 980001, avgLotSqft: 8000 },
};
const WRITE_CFG = { costDataVersion: 'v0.1.0-unclibrated', selectionHash: 'abcdef0123456789' };

describe('writeAggregates', () => {
  it('writes schema-valid JSON with the cost_data_version and selection hash', () => {
    const out = join(workdir, 'community-aggregates.json');
    const file = writeAggregates([ROW], WRITE_CFG, out);
    expect(file.costDataVersion).toBe('v0.1.0-unclibrated');
    expect(file.communities).toHaveLength(1);
    const parsed = communityAggregatesFileSchema.safeParse(JSON.parse(readFileSync(out, 'utf8')));
    expect(parsed.success).toBe(true);
    expect(cachedSelectionHash(out)).toBe('abcdef0123456789');
  });

  it('rejects malformed aggregates via the zod schema', () => {
    const bad = [{ ...ROW, slug: 'NOT KEBAB', count: -1 }];
    expect(() => writeAggregates(bad, WRITE_CFG, join(workdir, 'out.json'))).toThrow(/schema validation failed/);
  });

  it('fails the build on deny-listed terms', () => {
    const sneaky = [{ ...ROW, name: 'ALTADORE per_sqft' }];
    expect(() => writeAggregates(sneaky, WRITE_CFG, join(workdir, 'out.json'))).toThrow(/deny-list hit/);
  });
});

describe('scanDenyList', () => {
  it('flags proprietary cost-model terms', () => {
    expect(scanDenyList('{"a": 1, "per_sqft": 2}')).toContain('per_sqft');
    expect(scanDenyList('{"margin": 0.2}')).toContain('margin');
    expect(scanDenyList('{"costParams": {}}')).toContain('param');
  });

  it('passes clean content, including every new field', () => {
    expect(
      scanDenyList(
        JSON.stringify({
          generatedAt: '2026-09-24T00:00:00.000Z',
          costDataVersion: 'v0.1.0-unclibrated',
          selectionHash: 'abcdef0123456789',
          communities: [ROW],
        }),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ageInDays — the 30-day staleness guard
// ---------------------------------------------------------------------------
describe('ageInDays', () => {
  function writeAged(daysAgo: number): string {
    const out = join(workdir, 'community-aggregates.json');
    const generatedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    writeFileSync(out, JSON.stringify({ generatedAt, costDataVersion: 'v0.1.0-unclibrated', communities: [ROW] }));
    return out;
  }

  it('reports null for a missing file', () => {
    expect(ageInDays(join(workdir, 'missing.json'))).toBeNull();
    expect(cachedSelectionHash(join(workdir, 'missing.json'))).toBeNull();
  });

  it('reports a fresh file as under 30 days', () => {
    expect(ageInDays(writeAged(5))).toBeLessThan(30);
  });

  it('reports a 31-day-old file as stale (CI must fail)', () => {
    expect(ageInDays(writeAged(31))).toBeGreaterThanOrEqual(30);
  });

  it('treats a file without a selection hash as built from another config', () => {
    expect(cachedSelectionHash(writeAged(1))).toBeNull();
  });
});
