/**
 * Zoning source watch (#757) — service, freshness, route, timer wiring.
 *
 * AC1: a simulated City metadata change triggers a cache refresh and
 *      exactly one issue (deduplicated across runs and against an open issue).
 * AC2: the catalogue response carries its as-of date and a staleness flag
 *      when the City changed rules after it.
 * AC3: free sources only — the only URLs fetched are the City's open-data
 *      host, the City bylaw page and the GitHub REST API.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZoningDistrictsResponse } from '@feasly/contracts';
import { ZoningDistrictsResponseSchema } from '../src/openapi/schemas';
import { createZoningRoute } from '../src/routes/zoning.route';
import { createZoningService } from '../src/services/zoning.service';
import type { GitHubIssueRef, GitHubIssuesClient } from '../src/services/github-issues.client';
import { createGitHubIssuesClient } from '../src/services/github-issues.client';
import {
  ZONING_STALE_ISSUE_LABELS,
  ZONING_STALE_ISSUE_TITLE,
  createZoningWatchService,
  isCatalogueStale,
  issueSignature,
  latestChangeDetectedOn,
  normalisePageText,
  parseDistrictCodes,
  parseRowsUpdatedAt,
  type ZoningWatchServiceDeps,
} from '../src/services/zoning-watch.service';
import type { ZoningWatchState, ZoningWatchStore } from '../src/services/zoning-watch.store';

const SOCRATA = 'https://data.example.ca';
const DATASET = 'qe6k-p9nh';
const BYLAW_URL = 'https://city.example.ca/land-use-bylaw.html';
const EFFECTIVE = '2026-08-04';

const zoning = createZoningService({ config: { city: 'calgary' } });
const catalogue = zoning.getCatalogue()!;

// ── Fakes ────────────────────────────────────────────────────────────────

function memoryStore(): ZoningWatchStore & { rows: Map<string, ZoningWatchState> } {
  const rows = new Map<string, ZoningWatchState>();
  return {
    rows,
    get: (city) => Promise.resolve(rows.get(city)),
    put: (state) => {
      rows.set(state.city, state);
      return Promise.resolve();
    },
  };
}

/** The City as the watcher sees it; tests mutate it between runs. */
interface FakeCity {
  rowsUpdatedAt: number | null;
  codes: string[];
  page: string | null;
  lastModified?: string;
  fail?: boolean;
}

function fakeFetch(city: FakeCity): { fn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (city.fail) return Promise.reject(new Error('network down'));
    if (url === `${SOCRATA}/api/views/${DATASET}`) {
      return Promise.resolve(
        city.rowsUpdatedAt === null
          ? new Response('nope', { status: 500 })
          : Response.json({ id: DATASET, rowsUpdatedAt: city.rowsUpdatedAt }),
      );
    }
    if (url.startsWith(`${SOCRATA}/resource/${DATASET}.json?`)) {
      return Promise.resolve(Response.json(city.codes.map((lu_code) => ({ lu_code }))));
    }
    if (url === BYLAW_URL) {
      if (city.page === null) return Promise.resolve(new Response('', { status: 503 }));
      return Promise.resolve(
        new Response(city.page, {
          status: 200,
          headers: city.lastModified ? { 'Last-Modified': city.lastModified } : {},
        }),
      );
    }
    return Promise.reject(new Error(`unexpected URL ${url}`));
  }) as unknown as typeof fetch;
  return { fn, urls };
}

function fakeIssues(open?: GitHubIssueRef): GitHubIssuesClient & {
  created: Array<{ title: string; body: string; labels: readonly string[] }>;
  comments: Array<{ n: number; body: string }>;
  failCreate: boolean;
} {
  let openIssue = open;
  const client = {
    created: [] as Array<{ title: string; body: string; labels: readonly string[] }>,
    comments: [] as Array<{ n: number; body: string }>,
    failCreate: false,
    findOpenByTitle: (title: string) =>
      Promise.resolve(title === ZONING_STALE_ISSUE_TITLE ? openIssue : undefined),
    create: (input: { title: string; body: string; labels: readonly string[] }) => {
      if (client.failCreate) return Promise.reject(new Error('HTTP 502'));
      client.created.push(input);
      openIssue = { number: 900 + client.created.length, url: `https://github.example/issues/${900 + client.created.length}` };
      return Promise.resolve(openIssue);
    },
    comment: (n: number, body: string) => {
      client.comments.push({ n, body });
      return Promise.resolve();
    },
  };
  return client;
}

const CODES = ['R-C1', 'R-CG', 'M-C1'];
const PAGE_V1 = '<html><script>nonce=1</script><h1>Land Use Bylaw 1P2007</h1><p>Consolidated 2026-08-04</p></html>';
const PAGE_V2 = '<html><script>nonce=2</script><h1>Land Use Bylaw 1P2007</h1><p>Amended 2026-11-10 by 12P2026</p></html>';

function setup(overrides: Partial<ZoningWatchServiceDeps> = {}) {
  const city: FakeCity = { rowsUpdatedAt: 1_790_000_000, codes: [...CODES], page: PAGE_V1 };
  const { fn, urls } = fakeFetch(city);
  const store = memoryStore();
  const invalidateDataset = vi.fn((_id: string, _before: Date) => Promise.resolve(7));
  const issues = ('issues' in overrides ? overrides.issues : fakeIssues()) as ReturnType<typeof fakeIssues>;
  let clock = new Date('2026-11-16T11:30:00Z');
  const deps: ZoningWatchServiceDeps = {
    config: {
      enabled: true,
      city: 'calgary',
      socrataBaseUrl: SOCRATA,
      landUseDatasetId: DATASET,
      bylawPageUrl: BYLAW_URL,
      httpTimeoutMs: 1_000,
      githubRepo: 'owner/repo',
      githubToken: 'x',
      githubApiUrl: 'https://api.github.com',
      freshnessCacheTtlMs: 0,
    },
    zoning,
    store,
    cityDataCache: { invalidateDataset },
    ...(issues ? { issues } : {}),
    fetch: fn,
    now: () => clock,
    ...overrides,
  };
  const svc = createZoningWatchService(deps);
  return {
    svc,
    city,
    urls,
    store,
    issues,
    invalidateDataset,
    advance: (iso: string) => {
      clock = new Date(iso);
    },
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('zoning watch helpers', () => {
  it('parses Socrata rowsUpdatedAt (epoch seconds) and rejects junk', () => {
    expect(parseRowsUpdatedAt({ rowsUpdatedAt: 1_790_000_000 })?.toISOString()).toBe(
      new Date(1_790_000_000_000).toISOString(),
    );
    expect(parseRowsUpdatedAt({ rowsUpdatedAt: '1790000000' })).not.toBeNull();
    expect(parseRowsUpdatedAt({})).toBeNull();
    expect(parseRowsUpdatedAt(null)).toBeNull();
    expect(parseRowsUpdatedAt({ rowsUpdatedAt: -1 })).toBeNull();
  });

  it('parses district codes sorted and unique; null for a non-array body', () => {
    expect(parseDistrictCodes([{ lu_code: 'R-CG ' }, { lu_code: 'M-C1' }, { lu_code: 'R-CG' }, {}, null])).toEqual([
      'M-C1',
      'R-CG',
    ]);
    expect(parseDistrictCodes({ error: true })).toBeNull();
  });

  it('normalised page text ignores scripts, comments and markup, not words', () => {
    const a = normalisePageText('<p>Rules <b>A</b></p><script>x=1</script><!-- 1 -->');
    const b = normalisePageText('<div>Rules   A</div><script>x=2</script><!-- 2 -->');
    expect(a).toBe(b);
    expect(normalisePageText('<p>Rules B</p>')).not.toBe(a);
  });

  it('normalised page text hashes only <main>: header/footer/banner changes are ignored', () => {
    const page = (banner: string, body: string): string =>
      `<html><header><div class="alert">${banner}</div></header>` +
      `<main id="content"><h1>Land Use Bylaw</h1><p>${body}</p></main>` +
      `<footer>© ${banner}</footer></html>`;
    const a = normalisePageText(page('Road closure today', 'Rules A'));
    expect(normalisePageText(page('Service alert 2027', 'Rules A'))).toBe(a);
    expect(normalisePageText(page('Road closure today', 'Rules B'))).not.toBe(a);
    // No <main>: falls back to the whole page.
    expect(normalisePageText('<div>Banner</div><p>Rules A</p>')).toBe('Banner Rules A');
  });

  it('stale only for a bylaw change after effectiveDate or unknown codes', () => {
    expect(isCatalogueStale(EFFECTIVE, undefined)).toBe(false);
    expect(isCatalogueStale(EFFECTIVE, { bylawChangedAt: null, unknownDistrictCodes: [] })).toBe(false);
    expect(isCatalogueStale(EFFECTIVE, { bylawChangedAt: new Date('2026-08-01'), unknownDistrictCodes: [] })).toBe(false);
    expect(isCatalogueStale(EFFECTIVE, { bylawChangedAt: new Date('2026-11-10'), unknownDistrictCodes: [] })).toBe(true);
    expect(isCatalogueStale(EFFECTIVE, { bylawChangedAt: null, unknownDistrictCodes: ['H-GO2'] })).toBe(true);
  });

  it('latest change date picks the newest pending change', () => {
    expect(
      latestChangeDetectedOn(EFFECTIVE, {
        bylawChangedAt: new Date('2026-10-01T00:00:00Z'),
        unknownDistrictCodes: ['X-1'],
        datasetRowsUpdatedAt: new Date('2026-11-02T00:00:00Z'),
      }),
    ).toBe('2026-11-02');
    expect(
      latestChangeDetectedOn(EFFECTIVE, {
        bylawChangedAt: new Date('2026-07-01T00:00:00Z'),
        unknownDistrictCodes: [],
        datasetRowsUpdatedAt: new Date('2026-11-02T00:00:00Z'),
      }),
    ).toBeNull();
  });

  it('signature depends on the change, not on when it was seen', () => {
    const a = issueSignature(EFFECTIVE, new Date('2026-11-10T01:00:00Z'), ['X-1']);
    expect(issueSignature(EFFECTIVE, new Date('2026-11-10T23:00:00Z'), ['X-1'])).toBe(a);
    expect(issueSignature(EFFECTIVE, new Date('2026-11-10T01:00:00Z'), ['X-1', 'X-2'])).not.toBe(a);
  });
});

// ── runCheck ─────────────────────────────────────────────────────────────

describe('zoning watch runCheck', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('first run records a baseline: no issue, not stale', async () => {
    const r = await t.svc.runCheck();
    expect(r).toMatchObject({ skipped: false, bylawChanged: false, issue: 'none', stale: false });
    expect(r.unknownDistrictCodes).toEqual([]);
    const row = t.store.rows.get('calgary')!;
    expect(row.bylawPageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.bylawChangedAt).toBeNull();
    expect(row.datasetRowsUpdatedAt?.getTime()).toBe(1_790_000_000_000);
    expect(t.issues.created).toHaveLength(0);
  });

  it('AC1: a simulated dataset metadata change refreshes cached districts', async () => {
    await t.svc.runCheck();
    t.invalidateDataset.mockClear();
    // Unchanged metadata → no refresh.
    const same = await t.svc.runCheck();
    expect(same.datasetChanged).toBe(false);
    expect(t.invalidateDataset).not.toHaveBeenCalled();

    t.city.rowsUpdatedAt = 1_790_600_000;
    const r = await t.svc.runCheck();
    expect(r.datasetChanged).toBe(true);
    expect(r.cacheEntriesRefreshed).toBe(7);
    expect(t.invalidateDataset).toHaveBeenCalledTimes(1);
    expect(t.invalidateDataset).toHaveBeenCalledWith(DATASET, new Date(1_790_600_000_000));
  });

  it('AC1: a new district in the City dataset files exactly one issue across runs', async () => {
    await t.svc.runCheck();
    t.city.rowsUpdatedAt = 1_790_600_000;
    t.city.codes = [...CODES, 'H-GO2'];
    const first = await t.svc.runCheck();
    expect(first).toMatchObject({ datasetChanged: true, issue: 'created', stale: true });
    expect(first.unknownDistrictCodes).toEqual(['H-GO2']);
    expect(t.invalidateDataset).toHaveBeenCalled();

    // Same change on later days: deduplicated.
    t.advance('2026-11-17T11:30:00Z');
    const second = await t.svc.runCheck();
    t.city.rowsUpdatedAt = 1_791_200_000; // dataset touched again, same codes
    const third = await t.svc.runCheck();
    expect(second.issue).toBe('already-reported');
    expect(third.issue).toBe('already-reported');
    expect(t.issues.created).toHaveLength(1);
    expect(t.issues.comments).toHaveLength(0);

    const issue = t.issues.created[0]!;
    expect(issue.title).toBe(ZONING_STALE_ISSUE_TITLE);
    expect(issue.labels).toEqual(['bug', 'agent:ready']);
    expect(issue.labels).toEqual(ZONING_STALE_ISSUE_LABELS);
    expect(issue.body).toContain('`H-GO2`');
    expect(issue.body).toContain(EFFECTIVE);
    expect(t.store.rows.get('calgary')!.issueUrl).toBe('https://github.example/issues/901');
  });

  it('a bylaw page amendment is detected, dated, and reported once', async () => {
    await t.svc.runCheck();
    // Script nonce only → not an amendment.
    t.city.page = PAGE_V1.replace('nonce=1', 'nonce=9');
    expect((await t.svc.runCheck()).bylawChanged).toBe(false);

    t.city.page = PAGE_V2;
    t.city.lastModified = 'Tue, 10 Nov 2026 16:00:00 GMT';
    const r = await t.svc.runCheck();
    expect(r).toMatchObject({ bylawChanged: true, stale: true, issue: 'created' });
    expect(t.store.rows.get('calgary')!.bylawChangedAt?.toISOString()).toBe('2026-11-10T16:00:00.000Z');
    expect(t.issues.created[0]!.body).toContain('2026-11-10');
    expect(t.issues.created[0]!.body).toContain(BYLAW_URL);

    expect((await t.svc.runCheck()).issue).toBe('already-reported');
    expect(t.issues.created).toHaveLength(1);
  });

  it('dates an amendment by detection time when the page sends no Last-Modified', async () => {
    await t.svc.runCheck();
    t.city.page = PAGE_V2;
    t.advance('2026-11-20T11:30:00Z');
    await t.svc.runCheck();
    expect(t.store.rows.get('calgary')!.bylawChangedAt?.toISOString()).toBe('2026-11-20T11:30:00.000Z');
  });

  it('comments on the already-open issue instead of opening a second one', async () => {
    t = setup({ issues: fakeIssues({ number: 42, url: 'https://github.example/issues/42' }) });
    await t.svc.runCheck();
    t.city.codes = [...CODES, 'H-GO2'];
    const r = await t.svc.runCheck();
    expect(r.issue).toBe('commented');
    expect(t.issues.created).toHaveLength(0);
    expect(t.store.rows.get('calgary')!.issueUrl).toBe('https://github.example/issues/42');
  });

  it('a newer change on top of a reported one adds a comment, not a new issue', async () => {
    await t.svc.runCheck();
    t.city.codes = [...CODES, 'H-GO2'];
    await t.svc.runCheck();
    t.city.codes = [...CODES, 'H-GO2', 'X-NEW'];
    const r = await t.svc.runCheck();
    expect(r.issue).toBe('commented');
    expect(t.issues.created).toHaveLength(1);
    expect(t.issues.comments).toHaveLength(1);
    expect(t.issues.comments[0]!.body).toContain('`X-NEW`');
  });

  it('without a GitHub token records the change and files the issue once a token exists', async () => {
    const store = memoryStore();
    const noToken = setup({ issues: undefined, store });
    await noToken.svc.runCheck();
    noToken.city.codes = [...CODES, 'H-GO2'];
    const r = await noToken.svc.runCheck();
    expect(r).toMatchObject({ issue: 'no-token', stale: true });
    expect(store.rows.get('calgary')!.issueSignature).toBeNull();

    const issues = fakeIssues();
    const withToken = setup({ issues, store });
    withToken.city.codes = [...CODES, 'H-GO2'];
    expect((await withToken.svc.runCheck()).issue).toBe('created');
    expect(issues.created).toHaveLength(1);
  });

  it('a failed issue create is retried on the next run', async () => {
    await t.svc.runCheck();
    t.city.codes = [...CODES, 'H-GO2'];
    t.issues.failCreate = true;
    expect((await t.svc.runCheck()).issue).toBe('failed');
    t.issues.failCreate = false;
    expect((await t.svc.runCheck()).issue).toBe('created');
    expect(t.issues.created).toHaveLength(1);
  });

  it('City outages are "no information": no change, no issue, last state kept', async () => {
    await t.svc.runCheck();
    const before = t.store.rows.get('calgary')!;
    t.city.fail = true;
    const r = await t.svc.runCheck();
    expect(r).toMatchObject({ datasetChanged: false, bylawChanged: false, issue: 'none', stale: false });
    const after = t.store.rows.get('calgary')!;
    expect(after.bylawPageHash).toBe(before.bylawPageHash);
    expect(after.datasetRowsUpdatedAt).toEqual(before.datasetRowsUpdatedAt);
  });

  it('a cache refresh failure does not stop the check', async () => {
    t = setup({ cityDataCache: { invalidateDataset: () => Promise.reject(new Error('db')) } });
    const r = await t.svc.runCheck();
    expect(r).toMatchObject({ datasetChanged: true, cacheEntriesRefreshed: 0 });
    expect(t.store.rows.get('calgary')).toBeDefined();
  });

  it('disabled → skipped, nothing fetched', async () => {
    const off = setup();
    const svc = createZoningWatchService({
      config: { ...setupConfig(), enabled: false },
      zoning,
      store: off.store,
      cityDataCache: { invalidateDataset: off.invalidateDataset },
      fetch: fakeFetch({ rowsUpdatedAt: 1, codes: [], page: '' }).fn,
    });
    expect((await svc.runCheck()).skipped).toBe(true);
    expect(off.store.rows.size).toBe(0);
  });

  it('AC3: only free sources are fetched (City open data + City bylaw page)', async () => {
    await t.svc.runCheck();
    for (const url of t.urls) {
      expect(url.startsWith(SOCRATA) || url === BYLAW_URL).toBe(true);
    }
  });
});

function setupConfig(): ZoningWatchServiceDeps['config'] {
  return {
    enabled: true,
    city: 'calgary',
    socrataBaseUrl: SOCRATA,
    landUseDatasetId: DATASET,
    bylawPageUrl: BYLAW_URL,
    httpTimeoutMs: 1_000,
    githubRepo: 'owner/repo',
    githubToken: '',
    githubApiUrl: 'https://api.github.com',
    freshnessCacheTtlMs: 0,
  };
}

// ── Freshness + route (AC2) ──────────────────────────────────────────────

describe('zoning catalogue freshness (AC2)', () => {
  it('a current catalogue: as-of date, not stale', async () => {
    const t = setup();
    await t.svc.runCheck();
    const res = await createZoningRoute({ zoning, watch: t.svc }).handle();
    expect(res.freshness).toEqual({ rulesAsOf: EFFECTIVE, stale: false, latestChangeDetectedOn: null });
    expect(ZoningDistrictsResponseSchema.safeParse(res).success).toBe(true);
  });

  it('after a detected amendment: stale with the change date, schema-valid', async () => {
    const t = setup();
    await t.svc.runCheck();
    t.city.page = PAGE_V2;
    t.city.lastModified = 'Tue, 10 Nov 2026 16:00:00 GMT';
    await t.svc.runCheck();
    const res: ZoningDistrictsResponse = await createZoningRoute({ zoning, watch: t.svc }).handle();
    expect(res.freshness).toEqual({ rulesAsOf: EFFECTIVE, stale: true, latestChangeDetectedOn: '2026-11-10' });
    expect(res.effectiveDate).toBe(catalogue.effectiveDate);
    expect(res.sourceUrl).toBe(catalogue.sourceUrl);
    expect(ZoningDistrictsResponseSchema.safeParse(res).success).toBe(true);
  });

  it('no watch state yet → not stale', async () => {
    const t = setup();
    expect(await t.svc.getFreshness(catalogue)).toEqual({
      rulesAsOf: EFFECTIVE,
      stale: false,
      latestChangeDetectedOn: null,
    });
  });

  it('fails open when the state store errors', async () => {
    const store: ZoningWatchStore = {
      get: () => Promise.reject(new Error('db down')),
      put: () => Promise.resolve(),
    };
    const t = setup({ store });
    expect((await t.svc.getFreshness(catalogue)).stale).toBe(false);
  });

  it('caches the state read for freshnessCacheTtlMs', async () => {
    const store = memoryStore();
    const get = vi.spyOn(store, 'get');
    const t = setup({ store, config: { ...setupConfig(), freshnessCacheTtlMs: 60_000 } });
    await t.svc.getFreshness(catalogue);
    await t.svc.getFreshness(catalogue);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('route without a watch keeps the pure catalogue (no freshness field)', async () => {
    const res = await createZoningRoute({ zoning }).handle();
    expect(res.freshness).toBeUndefined();
  });
});

// ── GitHub client ────────────────────────────────────────────────────────

describe('GitHub issues client', () => {
  it('finds an exact-title open issue, creates, and comments with auth headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/search/issues')) {
        return Promise.resolve(
          Response.json({
            items: [
              { number: 1, html_url: 'u1', title: `${ZONING_STALE_ISSUE_TITLE} (old)` },
              { number: 2, html_url: 'u2', title: ZONING_STALE_ISSUE_TITLE },
            ],
          }),
        );
      }
      if (url.endsWith('/issues')) return Promise.resolve(Response.json({ number: 3, html_url: 'u3' }, { status: 201 }));
      return Promise.resolve(Response.json({ id: 1 }, { status: 201 }));
    }) as unknown as typeof fetch;
    const gh = createGitHubIssuesClient({ repo: 'o/r', token: 'tok', httpTimeoutMs: 1_000, apiBaseUrl: 'https://api.github.com' }, fetchImpl);
    expect(await gh.findOpenByTitle(ZONING_STALE_ISSUE_TITLE)).toEqual({ number: 2, url: 'u2' });
    expect(await gh.create({ title: 't', body: 'b', labels: ['bug'] })).toEqual({ number: 3, url: 'u3' });
    await gh.comment(2, 'c');
    expect(calls[1]!.url).toBe('https://api.github.com/repos/o/r/issues');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ title: 't', body: 'b', labels: ['bug'] });
    expect(calls[2]!.url).toBe('https://api.github.com/repos/o/r/issues/2/comments');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('errors never include the token', async () => {
    const fetchImpl = (() => Promise.resolve(new Response('no', { status: 401 }))) as unknown as typeof fetch;
    const gh = createGitHubIssuesClient({ repo: 'o/r', token: 'secret-token', httpTimeoutMs: 1_000, apiBaseUrl: 'https://api.github.com' }, fetchImpl);
    const err = await gh.create({ title: 't', body: 'b', labels: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('secret-token');
  });
});

describe('zoning-watch-timer function.json', () => {
  it('schedules the watch daily at 11:30 UTC', () => {
    const doc = JSON.parse(
      readFileSync(join(__dirname, '..', 'zoning-watch-timer', 'function.json'), 'utf8'),
    ) as { bindings?: Array<{ type?: string; schedule?: string }> };
    expect(doc.bindings?.find((b) => b.type === 'timerTrigger')?.schedule).toBe('0 30 11 * * *');
  });
});
