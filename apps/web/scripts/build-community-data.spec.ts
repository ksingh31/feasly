/**
 * SEO-03 spec: community data build script.
 *
 * Fixture-based coverage for both data paths (Socrata + properties-cache),
 * slug uniqueness/collision, zod validation, deny-list scan, and the
 * 30-day staleness guard.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ageInDays,
  buildAggregates,
  fetchFromDatabase,
  fetchFromSocrata,
  loadConfig,
  slugify,
  writeAggregates,
} from './build-community-data.js';
import {
  communityAggregatesFileSchema,
  scanDenyList,
} from './community-aggregates.schema.js';

// ---------------------------------------------------------------------------
// pg mock (properties-cache path)
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();

vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = mockConnect;
      query = mockQuery;
      end = mockEnd;
    },
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SOCRATA_FIXTURE = [
  { comm_name: 'BELTLINE', count: '21589', avg_assessed_value: '650000.5', avg_land_size_sf: '12000.7' },
  { comm_name: 'PANORAMA HILLS', count: '9271', avg_assessed_value: '720000', avg_land_size_sf: '4500' },
  { comm_name: '', count: '100', avg_assessed_value: '500000', avg_land_size_sf: '3000' },
  { comm_name: 'NOWHERE', count: '50', avg_assessed_value: null, avg_land_size_sf: '3000' },
];

const DB_FIXTURE_ROWS = [
  { comm_name: 'CRANSTON', count: '8974', avg_assessed_value: '680000.2', avg_land_size_sf: '5200.9' },
  { comm_name: 'ASPEN WOODS', count: '6102', avg_assessed_value: '950000', avg_land_size_sf: '8000' },
];

function stubFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as Response) as typeof fetch;
}

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'community-data-'));
  vi.clearAllMocks();
  mockEnd.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------
describe('loadConfig', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env['COMMUNITY_PAGE_LIMIT'];
    delete process.env['DATABASE_URL'];
  });

  it('defaults the page limit to 40', () => {
    expect(loadConfig([]).pageLimit).toBe(40);
  });

  it('reads COMMUNITY_PAGE_LIMIT from the environment', () => {
    process.env['COMMUNITY_PAGE_LIMIT'] = '10';
    expect(loadConfig([]).pageLimit).toBe(10);
  });

  it('rejects a non-numeric page limit', () => {
    process.env['COMMUNITY_PAGE_LIMIT'] = 'many';
    expect(() => loadConfig([])).toThrow(/COMMUNITY_PAGE_LIMIT/);
  });

  it('treats an unset DATABASE_URL as the Socrata path', () => {
    expect(loadConfig([]).databaseUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// slugify / buildAggregates
// ---------------------------------------------------------------------------
describe('slugify', () => {
  it('converts City names to kebab-case', () => {
    expect(slugify('PANORAMA HILLS')).toBe('panorama-hills');
    expect(slugify("MCKENZIE TOWNE")).toBe('mckenzie-towne');
    expect(slugify('  Beltline  ')).toBe('beltline');
  });
});

describe('buildAggregates', () => {
  it('takes the top-N rows and drops unusable ones', () => {
    const warnings: string[] = [];
    const result = buildAggregates(
      SOCRATA_FIXTURE.map((r) => ({
        commName: r.comm_name,
        count: r.count,
        avgAssessedValue: r.avg_assessed_value,
        avgLotSqft: r.avg_land_size_sf,
      })),
      40,
      (m) => warnings.push(m),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      slug: 'beltline',
      name: 'BELTLINE',
      count: 21589,
      avgAssessedValue: 650001,
      avgLotSqft: 12001,
    });
    expect(result[1]?.slug).toBe('panorama-hills');
    expect(warnings).toHaveLength(0);
  });

  it('disambiguates slug collisions and logs them', () => {
    const warnings: string[] = [];
    const result = buildAggregates(
      [
        { commName: 'FOO BAR', count: 10, avgAssessedValue: 100, avgLotSqft: 100 },
        { commName: 'FOO-BAR', count: 9, avgAssessedValue: 100, avgLotSqft: 100 },
      ],
      40,
      (m) => warnings.push(m),
    );
    expect(result.map((r) => r.slug)).toEqual(['foo-bar', 'foo-bar-2']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/slug collision/);
  });
});

// ---------------------------------------------------------------------------
// fetchFromSocrata (fixture-based)
// ---------------------------------------------------------------------------
describe('fetchFromSocrata', () => {
  it('maps the SoQL GROUP BY rows onto raw aggregates', async () => {
    const rows = await fetchFromSocrata(
      { socrataBaseUrl: 'https://data.calgary.ca', socrataDataset: '4bsw-nn7w' },
      stubFetch(SOCRATA_FIXTURE),
    );
    expect(rows[0]).toMatchObject({ commName: 'BELTLINE', count: '21589' });
    expect(rows).toHaveLength(4);
  });

  it('throws on a non-OK response', async () => {
    await expect(
      fetchFromSocrata(
        { socrataBaseUrl: 'https://data.calgary.ca', socrataDataset: '4bsw-nn7w' },
        stubFetch([], false, 429),
      ),
    ).rejects.toThrow(/HTTP 429/);
  });
});

// ---------------------------------------------------------------------------
// fetchFromDatabase (fixture-based, pg mocked)
// ---------------------------------------------------------------------------
describe('fetchFromDatabase', () => {
  it('queries the properties cache and maps rows', async () => {
    mockQuery.mockResolvedValue({ rows: DB_FIXTURE_ROWS });
    const rows = await fetchFromDatabase('postgres://localhost:5432/feasly');
    expect(mockConnect).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = String(mockQuery.mock.calls[0]?.[0] ?? '');
    expect(sql).toMatch(/FROM properties/);
    expect(sql).toMatch(/GROUP BY comm_name/);
    expect(rows[0]).toMatchObject({ commName: 'CRANSTON', count: '8974' });
    expect(mockEnd).toHaveBeenCalled();
  });

  it('propagates connection failures so the caller can fall back to Socrata', async () => {
    mockConnect.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(fetchFromDatabase('postgres://localhost:5432/feasly')).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

// ---------------------------------------------------------------------------
// writeAggregates + schema + deny-list
// ---------------------------------------------------------------------------
describe('writeAggregates', () => {
  const aggregates = [
    { slug: 'beltline', name: 'BELTLINE', count: 21589, avgAssessedValue: 650000, avgLotSqft: 12000 },
  ];

  it('writes schema-valid JSON with the configured cost_data_version', () => {
    const out = join(workdir, 'community-aggregates.json');
    const file = writeAggregates(aggregates, { costDataVersion: 'v0.1.0-unclibrated' }, out);
    expect(file.costDataVersion).toBe('v0.1.0-unclibrated');
    expect(file.communities).toHaveLength(1);
    const parsed = communityAggregatesFileSchema.safeParse(JSON.parse(readFileSync(out, 'utf8')));
    expect(parsed.success).toBe(true);
  });

  it('rejects malformed aggregates via the zod schema', () => {
    const bad = [{ slug: 'NOT KEBAB', name: '', count: -1, avgAssessedValue: 1.5, avgLotSqft: 0 }];
    expect(() =>
      writeAggregates(bad, { costDataVersion: 'v0.1.0-unclibrated' }, join(workdir, 'out.json')),
    ).toThrow(/schema validation failed/);
  });

  it('fails the build on deny-listed terms', () => {
    const sneaky = [
      {
        slug: 'beltline',
        name: 'BELTLINE per_sqft',
        count: 10,
        avgAssessedValue: 100,
        avgLotSqft: 100,
      },
    ];
    expect(() =>
      writeAggregates(sneaky, { costDataVersion: 'v0.1.0-unclibrated' }, join(workdir, 'out.json')),
    ).toThrow(/deny-list hit/);
  });
});

describe('scanDenyList', () => {
  it('flags proprietary cost-model terms', () => {
    expect(scanDenyList('{"a": 1, "per_sqft": 2}')).toContain('per_sqft');
    expect(scanDenyList('{"margin": 0.2}')).toContain('margin');
    expect(scanDenyList('{"costParams": {}}')).toContain('param');
  });

  it('passes clean content', () => {
    expect(
      scanDenyList(
        JSON.stringify({
          generatedAt: '2026-09-24T00:00:00.000Z',
          costDataVersion: 'v0.1.0-unclibrated',
          communities: [{ slug: 'beltline', name: 'BELTLINE', count: 1, avgAssessedValue: 2, avgLotSqft: 3 }],
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
    writeFileSync(
      out,
      JSON.stringify({
        generatedAt,
        costDataVersion: 'v0.1.0-unclibrated',
        communities: [{ slug: 'a', name: 'A', count: 1, avgAssessedValue: 1, avgLotSqft: 1 }],
      }),
    );
    return out;
  }

  it('reports null for a missing file', () => {
    expect(ageInDays(join(workdir, 'missing.json'))).toBeNull();
  });

  it('reports a fresh file as under 30 days', () => {
    expect(ageInDays(writeAged(5))).toBeLessThan(30);
  });

  it('reports a 31-day-old file as stale (CI must fail)', () => {
    expect(ageInDays(writeAged(31))).toBeGreaterThanOrEqual(30);
  });
});
