/**
 * #690 spec: which averages each community page type shows.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadIntros, pageAggregate } from './build-community-pages.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'data');

const ALTADORE = {
  slug: 'altadore',
  name: 'ALTADORE',
  count: 2044,
  avgAssessedValue: 1303428,
  avgLotSqft: 4272,
  basis: 'detached-semi' as const,
  group: 'established' as const,
  sector: 'CENTRE',
  residential: { count: 3100, avgAssessedValue: 980001, avgLotSqft: 8000 },
};

describe('pageAggregate', () => {
  it('guide pages show the single/semi-detached averages only', () => {
    expect(pageAggregate(ALTADORE, 'build-guide')).toEqual({
      slug: 'altadore',
      name: 'ALTADORE',
      count: 2044,
      avgAssessedValue: 1303428,
      avgLotSqft: 4272,
    });
  });

  it('profile pages show the all-residential averages', () => {
    expect(pageAggregate(ALTADORE, 'profile')).toMatchObject({ count: 3100, avgAssessedValue: 980001 });
  });

  it('refuses a guide built on a condo-inclusive average', () => {
    expect(() => pageAggregate({ ...ALTADORE, basis: 'residential' }, 'build-guide')).toThrow(/condo records/);
  });
});

/** The established infill communities named in marketing plan section 3, as the City spells them. */
const INFILL_COMMUNITIES = [
  'ALTADORE', 'SOUTH CALGARY', 'KILLARNEY/GLENGARRY', 'RICHMOND', 'MOUNT PLEASANT', 'CAPITOL HILL',
  'TUXEDO PARK', 'CRESCENT HEIGHTS', 'RENFREW', 'HILLHURST', 'WEST HILLHURST', 'PARKDALE',
  'ST. ANDREWS HEIGHTS', 'MONTGOMERY', 'BANFF TRAIL', 'HIGHLAND PARK', 'WINSTON HEIGHTS/MOUNTVIEW',
  'ROSEDALE', 'CAMBRIAN HEIGHTS', 'LAKEVIEW', 'ELBOYA', 'BRITANNIA', 'BANKVIEW', 'SPRUCE CLIFF',
  'WILDWOOD', 'GLENDALE', 'INGLEWOOD', 'RAMSAY',
];

describe('community intros (SEO/GEO gap 3)', () => {
  const names = (
    JSON.parse(readFileSync(join(DATA_DIR, 'community-aggregates.json'), 'utf8')) as { communities: Array<{ name: string }> }
  ).communities.map((c) => c.name);

  it('every established infill community has a page and its own hand-written intro', () => {
    const intros = loadIntros(names);
    for (const name of INFILL_COMMUNITIES) {
      expect(names).toContain(name);
      expect(intros.get(name)?.body.length ?? 0).toBeGreaterThan(120);
    }
  });

  it('rejects an intro whose name matches no selected community', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intros-'));
    const file = join(dir, 'intros.json');
    const intro = { summary: 'A long enough summary sentence about a community.', body: 'A long enough body sentence about the same community.' };
    writeFileSync(file, JSON.stringify({ intros: { 'MARDA LOOP': intro } }));
    expect(() => loadIntros(names, file)).toThrow(/matches no selected community/);
  });

  it('rejects reused sentences (template swaps are not unique copy) and banned words', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intros-'));
    const same = { summary: 'Quiet inner-city streets close to the river and downtown.', body: 'Older bungalows are being replaced by new infill homes.' };
    const dup = join(dir, 'dup.json');
    writeFileSync(dup, JSON.stringify({ intros: { ALTADORE: same, RICHMOND: same } }));
    expect(() => loadIntros(names, dup)).toThrow(/reused/);
    const banned = join(dir, 'banned.json');
    writeFileSync(banned, JSON.stringify({ intros: { ALTADORE: { ...same, body: 'Homes here hold their market value better than most areas.' } } }));
    expect(() => loadIntros(names, banned)).toThrow(/copy rules/);
  });
});
