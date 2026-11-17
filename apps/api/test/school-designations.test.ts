/**
 * School designations (#775) against PGlite.
 *
 * AC1: Altadore (fixture) returns K–6, 7–9 and 10–12 designations for both
 *      boards, with lookup links.
 * AC2: address responses always say "typically designated" and include the
 *      lookup links.
 * AC3: a changed designation in a refresh produces one review issue
 *      (deduplicated).
 * Also: curated-list validation, the change diff, provider selection by
 * config, no provider reachable from the read path, route validation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { loadConfig } from '../src/config';
import {
  createBoardPublishedDesignationProvider,
  createNeighbourhoodProviders,
  type NeighbourhoodProvider,
  type NeighbourhoodProviders,
} from '../src/services/neighbourhood-data/providers';
import { createDrizzleNeighbourhoodDataStore } from '../src/services/neighbourhood-data/neighbourhood-data.store';
import { createNeighbourhoodRefreshService } from '../src/services/neighbourhood-data/neighbourhood-refresh.service';
import {
  buildDesignationRecords,
  diffDesignations,
  InvalidDesignationError,
  type CuratedDesignation,
} from '../src/services/neighbourhood-data/school-designations';
import { createSchoolDesignationReadService } from '../src/services/neighbourhood-data/school-designation-read.service';
import {
  createSchoolDesignationReviewService,
  SCHOOL_DESIGNATIONS_REVIEW_ISSUE_LABELS,
  SCHOOL_DESIGNATIONS_REVIEW_ISSUE_TITLE,
} from '../src/services/neighbourhood-data/school-designation-review.service';
import type { GitHubIssuesClient } from '../src/services/github-issues.client';
import { createSchoolDesignationsRoute } from '../src/routes/school-designations.route';
import { HttpError } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

const LOOKUP = { cbe: 'https://cbe.example/find-a-school', ccsd: 'https://ccsd.example/school-finder' };

/** Test fixture — illustrative school names, not real designations. */
function altadore(overrides: Partial<Record<string, string>> = {}): CuratedDesignation[] {
  const entry = (board: 'cbe' | 'ccsd', gradeBand: 'K-6' | '7-9' | '10-12', schoolName: string) => ({
    communityCode: 'ALT',
    communityName: 'Altadore',
    board,
    gradeBand,
    schoolName: overrides[`${board}|${gradeBand}`] ?? schoolName,
    sourceUrl: `https://${board}.example/designations`,
    schoolYear: '2026-27',
  });
  return [
    entry('cbe', 'K-6', 'Fixture Elementary'),
    entry('cbe', '7-9', 'Fixture Junior High'),
    entry('cbe', '10-12', 'Fixture High'),
    entry('ccsd', 'K-6', 'St. Fixture Elementary'),
    entry('ccsd', '7-9', 'St. Fixture Junior High'),
    entry('ccsd', '10-12', 'St. Fixture High'),
  ];
}

function none<T>(): NeighbourhoodProvider<T, 'none'> {
  return { implementation: 'none', fetchAll: async () => [] };
}

/** In-memory GitHub issues: tracks creates and comments. */
function fakeIssues() {
  const state = {
    issues: [] as Array<{ number: number; title: string; body: string; labels: readonly string[]; open: boolean }>,
    comments: [] as Array<{ issue: number; body: string }>,
    fail: false,
  };
  const client: GitHubIssuesClient = {
    async findOpenByTitle(title) {
      if (state.fail) throw new Error('GitHub down');
      const found = state.issues.find((i) => i.open && i.title === title);
      return found ? { number: found.number, url: `https://github.example/${found.number}` } : undefined;
    },
    async create({ title, body, labels }) {
      if (state.fail) throw new Error('GitHub down');
      const number = state.issues.length + 1;
      state.issues.push({ number, title, body, labels, open: true });
      return { number, url: `https://github.example/${number}` };
    },
    async comment(issue, body) {
      if (state.fail) throw new Error('GitHub down');
      state.comments.push({ issue, body });
    },
  };
  return { client, state };
}

function property(community: string): PropertyRecord {
  return { community } as unknown as PropertyRecord;
}

describe('school designations — pure helpers (#775)', () => {
  it('builds one record per community, board and grade band', () => {
    const records = buildDesignationRecords(altadore());
    expect(records).toHaveLength(6);
    expect(records[0]).toMatchObject({
      externalId: 'cbe|alt|k-6',
      communityCode: 'ALT',
      gradeBand: 'K-6',
      data: { board: 'cbe', boardName: 'Calgary Board of Education', schoolName: 'Fixture Elementary', slug: 'altadore' },
    });
  });

  it('rejects invalid or duplicated entries (fails the refresh, keeps old data)', () => {
    const [first] = altadore();
    expect(() => buildDesignationRecords([first!, first!])).toThrow(InvalidDesignationError);
    expect(() => buildDesignationRecords([{ ...first!, schoolName: ' ' }])).toThrow(InvalidDesignationError);
    expect(() => buildDesignationRecords([{ ...first!, gradeBand: '1-3' as never }])).toThrow(
      InvalidDesignationError,
    );
    expect(() => buildDesignationRecords([{ ...first!, board: 'fsd' as never }])).toThrow(InvalidDesignationError);
    expect(() => buildDesignationRecords([{ ...first!, communityCode: 'not a code' }])).toThrow(
      InvalidDesignationError,
    );
  });

  it('diffs added, removed and changed designations; first load is not a change', () => {
    const before = buildDesignationRecords(altadore()).map((r) => ({ ...r, gradeBand: r.gradeBand }));
    expect(diffDesignations([], before)).toEqual([]);
    // Same school, different case/spacing → not a change.
    const recased = buildDesignationRecords(altadore({ 'cbe|K-6': 'fixture   ELEMENTARY' }));
    expect(diffDesignations(before, recased)).toEqual([]);

    const after = buildDesignationRecords(altadore({ 'ccsd|7-9': 'St. Other Junior High' })).filter(
      (r) => r.externalId !== 'cbe|alt|10-12',
    );
    after.push(
      ...buildDesignationRecords([
        { communityCode: 'ALT', communityName: 'Altadore', board: 'cbe', gradeBand: 'K-9', schoolName: 'New K-9' },
      ]),
    );
    expect(diffDesignations(before, after)).toEqual([
      expect.objectContaining({ key: 'cbe|alt|10-12', kind: 'removed', before: 'Fixture High', after: null }),
      expect.objectContaining({ key: 'cbe|alt|k-9', kind: 'added', before: null, after: 'New K-9' }),
      expect.objectContaining({
        key: 'ccsd|alt|7-9',
        kind: 'changed',
        board: 'ccsd',
        gradeBand: '7-9',
        communityName: 'Altadore',
        before: 'St. Fixture Junior High',
        after: 'St. Other Junior High',
      }),
    ]);
  });

  it('config chooses the implementation (default none; board-published on switch)', () => {
    const base = loadConfig(BASE_ENV).neighbourhoodData;
    expect(createNeighbourhoodProviders(base).schoolDesignation.implementation).toBe('none');
    const switched = createNeighbourhoodProviders({
      ...base,
      providers: { ...base.providers, schoolDesignation: 'board-published' },
    });
    expect(switched.schoolDesignation.implementation).toBe('board-published');
    expect(loadConfig(BASE_ENV).neighbourhoodData.schoolBoardLookupUrls).toEqual({
      cbe: 'https://www.cbe.ab.ca/find-a-school',
      ccsd: 'https://www.cssd.ab.ca',
    });
  });

  it('the read path never reaches a provider or the refresh job', () => {
    const src = join(__dirname, '../src');
    for (const file of [
      'services/neighbourhood-data/school-designation-read.service.ts',
      'routes/school-designations.route.ts',
    ]) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toMatch(/providers'|neighbourhood-refresh\.service|school-designations\.data/);
    }
  });
});

describe('school designations — refresh, review issue and reads (#775)', () => {
  let testDb: TestDb;
  let entries: CuratedDesignation[];
  let issues: ReturnType<typeof fakeIssues>;
  let clockNow: Date;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  beforeEach(async () => {
    await testDb.exec(
      'DELETE FROM school_designations; DELETE FROM amenities; DELETE FROM neighbourhood_refresh_state;',
    );
    entries = altadore();
    issues = fakeIssues();
    clockNow = new Date('2026-11-17T07:00:00Z');
    // Established-community anchor (#690/#777): Altadore's tree-cover row.
    await store().replaceSnapshot(
      'amenities',
      'calgary-open-data',
      [
        {
          externalId: 'tree-cover|alt',
          category: 'tree-cover',
          name: 'ALTADORE',
          communityCode: 'ALT',
          lat: 51.01,
          lng: -114.1,
          data: { slug: 'altadore', publicTrees: 1, areaHa: 1, treesPerHa: 1 },
        },
      ],
      clockNow,
    );
  });

  function store() {
    return createDrizzleNeighbourhoodDataStore({ db: testDb.db });
  }

  function refreshService(withIssues = true) {
    const providers = {
      schoolDirectory: none(),
      // Reads `entries` at fetch time so a test can edit the curated list.
      schoolDesignation: {
        implementation: 'board-published',
        fetchAll: () => createBoardPublishedDesignationProvider(entries).fetchAll(),
      },
      schoolRatings: none(),
      reviews: none(),
      amenities: none(),
      commute: none(),
    } as unknown as NeighbourhoodProviders;
    const review = createSchoolDesignationReviewService({
      ...(withIssues ? { issues: issues.client } : {}),
      logger: { info: () => {}, warn: () => {} },
    });
    return createNeighbourhoodRefreshService({
      providers,
      store: store(),
      refreshDayOfMonth: 1,
      alertAfterFailureDays: 3,
      onDesignationsChanged: (changes, at) => review.report(changes, at).then(() => undefined),
      clock: () => clockNow,
      logWarning: () => {},
    });
  }

  function reads(community = 'ALTADORE') {
    let propertyCalls = 0;
    const service = createSchoolDesignationReadService({
      store: store(),
      properties: {
        getProperty: async () => {
          propertyCalls++;
          return property(community);
        },
      },
      lookupUrls: LOOKUP,
    });
    return { service, calls: () => propertyCalls };
  }

  it('AC1: Altadore returns K–6, 7–9 and 10–12 for both boards, with lookup links', async () => {
    const result = await refreshService().refreshNow('school-designation');
    expect(result).toMatchObject({ outcome: 'ok', rowsChanged: 6, rowsTotal: 6, changesFlagged: 0 });

    for (const key of ['altadore', 'ALT']) {
      const body = await reads().service.forCommunity(key);
      expect(body).not.toBeNull();
      expect(body!).toMatchObject({ communityCode: 'ALT', slug: 'altadore', label: 'typically designated' });
      expect(body!.designations.map((d) => `${d.board} ${d.gradeBand} ${d.schoolName}`)).toEqual([
        'cbe K-6 Fixture Elementary',
        'cbe 7-9 Fixture Junior High',
        'cbe 10-12 Fixture High',
        'ccsd K-6 St. Fixture Elementary',
        'ccsd 7-9 St. Fixture Junior High',
        'ccsd 10-12 St. Fixture High',
      ]);
      for (const d of body!.designations) {
        expect(d.label).toBe('typically designated');
        expect(d.lookupUrl).toBe(LOOKUP[d.board]);
      }
      expect(body!.boards).toEqual([
        { board: 'cbe', name: 'Calgary Board of Education', lookupUrl: LOOKUP.cbe },
        { board: 'ccsd', name: 'Calgary Catholic School District', lookupUrl: LOOKUP.ccsd },
      ]);
      expect(body!.disclaimer).toMatch(/confirm with the board/i);
    }
    // Not an established community we cover → null (route answers 404).
    expect(await reads().service.forCommunity('beltline')).toBeNull();
  });

  it('AC2: address responses always say "typically designated" and include the lookup links', async () => {
    await refreshService().refreshNow('school-designation');

    const known = reads('ALTADORE');
    const body = await known.service.forAddress('123 FIXTURE ST SW');
    expect(known.calls()).toBe(1);
    expect(body).toMatchObject({
      addressKey: '123 FIXTURE ST SW',
      communityCode: 'ALT',
      slug: 'altadore',
      label: 'typically designated',
    });
    expect(body.designations).toHaveLength(6);
    expect(body.designations.every((d) => d.label === 'typically designated' && d.lookupUrl.length > 0)).toBe(true);
    expect(body.boards.map((b) => b.lookupUrl)).toEqual([LOOKUP.cbe, LOOKUP.ccsd]);

    // Community without designations / unknown community: still labelled, still linked.
    for (const community of ['BELTLINE', 'Calgary']) {
      const other = await reads(community).service.forAddress('1 OTHER AV SW');
      expect(other.label).toBe('typically designated');
      expect(other.designations).toEqual([]);
      expect(other.boards.map((b) => b.lookupUrl)).toEqual([LOOKUP.cbe, LOOKUP.ccsd]);
      expect(other.disclaimer).toMatch(/confirm with the board/i);
    }
    const unknown = await reads('Calgary').service.forAddress('1 OTHER AV SW');
    expect(unknown).toMatchObject({ communityCode: null, communityName: null, slug: null });
  });

  it('AC3: a changed designation produces one review issue, deduplicated', async () => {
    const service = refreshService();
    // First load: no stored snapshot → nothing to review.
    await service.refreshNow('school-designation');
    expect(issues.state.issues).toHaveLength(0);

    // Two designations change in one refresh → ONE issue listing both.
    entries = altadore({ 'cbe|7-9': 'Other Junior High', 'ccsd|10-12': 'St. Other High' });
    const changed = await service.refreshNow('school-designation');
    expect(changed).toMatchObject({ outcome: 'ok', rowsChanged: 2, changesFlagged: 2 });
    expect(issues.state.issues).toHaveLength(1);
    const [issue] = issues.state.issues;
    expect(issue!.title).toBe(SCHOOL_DESIGNATIONS_REVIEW_ISSUE_TITLE);
    expect(issue!.labels).toEqual(SCHOOL_DESIGNATIONS_REVIEW_ISSUE_LABELS);
    expect(issue!.body).toContain('| Altadore (ALT) | CBE | 7-9 | changed | Fixture Junior High | Other Junior High |');
    expect(issue!.body).toContain('| Altadore (ALT) | CCSD | 10-12 | changed | St. Fixture High | St. Other High |');
    // The changed designations are served.
    const served = await reads().service.forCommunity('ALT');
    expect(served!.designations.find((d) => d.board === 'cbe' && d.gradeBand === '7-9')!.schoolName).toBe(
      'Other Junior High',
    );

    // Re-running the same refresh: no change → no new issue, no comment.
    const again = await service.refreshNow('school-designation');
    expect(again).toMatchObject({ outcome: 'ok', rowsChanged: 0, changesFlagged: 0 });
    expect(issues.state.issues).toHaveLength(1);
    expect(issues.state.comments).toHaveLength(0);

    // Another change while the review issue is open → a comment on it, not a new issue.
    entries = altadore({ 'cbe|7-9': 'Other Junior High', 'ccsd|10-12': 'St. Other High', 'cbe|K-6': 'Other Elementary' });
    await service.refreshNow('school-designation');
    expect(issues.state.issues).toHaveLength(1);
    expect(issues.state.comments).toEqual([
      { issue: 1, body: expect.stringContaining('| Altadore (ALT) | CBE | K-6 | changed | Fixture Elementary | Other Elementary |') },
    ]);
  });

  it('AC3: if the review issue cannot be filed, the refresh fails, keeps the old data and retries', async () => {
    const service = refreshService();
    await service.refreshNow('school-designation');
    entries = altadore({ 'cbe|K-6': 'Other Elementary' });

    issues.state.fail = true;
    const failed = await service.refreshNow('school-designation');
    expect(failed).toMatchObject({ outcome: 'failed', consecutiveFailures: 1 });
    const kept = await reads().service.forCommunity('ALT');
    expect(kept!.designations[0]!.schoolName).toBe('Fixture Elementary');

    issues.state.fail = false;
    const retried = await service.refreshNow('school-designation');
    expect(retried).toMatchObject({ outcome: 'ok', changesFlagged: 1 });
    expect(issues.state.issues).toHaveLength(1);
    const now = await reads().service.forCommunity('ALT');
    expect(now!.designations[0]!.schoolName).toBe('Other Elementary');
  });

  it('without a GitHub token the change is detected and logged, and the refresh still succeeds', async () => {
    const service = refreshService(false);
    await service.refreshNow('school-designation');
    entries = altadore({ 'cbe|K-6': 'Other Elementary' });
    const result = await service.refreshNow('school-designation');
    expect(result).toMatchObject({ outcome: 'ok', changesFlagged: 1 });
    expect(issues.state.issues).toHaveLength(0);
  });

  it('an empty curated list is a failed refresh that keeps the stored designations', async () => {
    const service = refreshService();
    await service.refreshNow('school-designation');
    entries = [];
    const result = await service.refreshNow('school-designation');
    expect(result).toMatchObject({ outcome: 'failed', error: 'EmptySnapshotError' });
    expect((await reads().service.forCommunity('ALT'))!.designations).toHaveLength(6);
    expect(issues.state.issues).toHaveLength(0);
  });
});

describe('school designations route (#775)', () => {
  const body = {
    label: 'typically designated' as const,
    designations: [],
    boards: [],
    disclaimer: 'x',
  };
  const route = createSchoolDesignationsRoute({
    designations: {
      forCommunity: async (key) =>
        key === 'altadore' ? { ...body, communityCode: 'ALT', communityName: 'Altadore', slug: 'altadore' } : null,
      forAddress: async (addressKey) => ({ ...body, addressKey, communityCode: null, communityName: null, slug: null }),
    },
  });

  async function status(p: Promise<unknown>): Promise<number> {
    try {
      await p;
      return 200;
    } catch (e) {
      return e instanceof HttpError ? e.status : 500;
    }
  }

  it('validates the slug and answers 404 for an uncovered community', async () => {
    expect(await status(route.community('altadore'))).toBe(200);
    expect(await status(route.community('beltline'))).toBe(404);
    for (const bad of [undefined, '', 'bad slug!', 'a'.repeat(65), 42]) {
      expect(await status(route.community(bad))).toBe(400);
    }
  });

  it('requires addressKey (bounded) and passes it trimmed', async () => {
    await expect(route.address({ addressKey: ' 1 MAIN ST SW ' })).resolves.toMatchObject({ addressKey: '1 MAIN ST SW' });
    expect(await status(route.address(undefined))).toBe(400);
    expect(await status(route.address({ addressKey: '  ' }))).toBe(400);
    expect(await status(route.address({ addressKey: 'x'.repeat(201) }))).toBe(400);
  });
});
