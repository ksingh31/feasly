/**
 * Zoning source watch (#757): keep the zoning catalogue honest about City
 * rule changes.
 *
 * A daily timer runs `runCheck()`:
 * 1. Reads three free City signals, each independently (a failed signal is
 *    "no information", never "changed"):
 *    - Land Use Districts dataset metadata `rowsUpdatedAt`
 *      (`GET {socrata}/api/views/{datasetId}`);
 *    - the district codes in that dataset
 *      (`$select=lu_code&$group=lu_code`), diffed against the catalogue —
 *      a code the catalogue doesn't know means the bylaw added a district;
 *    - the Land Use Bylaw page, as a sha256 of its normalised text (plus
 *      `Last-Modified` when the server sends one) — a new hash is a
 *      detected amendment (the first sighting is a baseline only).
 * 2. When the dataset was updated since last seen, drops cached district
 *    lookups fetched before that update (shared City-data cache, #756), so
 *    the next lookup reads the City's current map.
 * 3. When the catalogue looks out of date (a bylaw change after its
 *    `effectiveDate`, or unknown district codes), files ONE GitHub issue
 *    "Zoning catalogue may be out of date" (`bug` + `agent:ready`) with the
 *    diff summary. Deduplicated twice: the state row stores the signature
 *    of the change already reported, and an open issue with the same title
 *    gets a comment instead of a second issue. No token configured → the
 *    change is recorded and logged, no issue (retried once a token exists).
 *
 * `getFreshness()` feeds GET /zoning/districts: `stale` is true while the
 * catalogue is older than the latest detected change. Fail-open: a db error
 * reads as "not stale" (the panel still links to the City).
 *
 * No process.env (config arrives via deps); db only through the stores.
 */
import { createHash } from 'node:crypto';
import type { ZoningCatalogueFreshness, ZoningDistrictsResponse } from '@feasly/contracts';
import type { ZoningWatchConfig } from '../config';
import type { CityDataCacheInvalidator } from './city-data-cache.store';
import type { GitHubIssuesClient } from './github-issues.client';
import type { ZoningService } from './zoning.service';
import type { ZoningWatchState, ZoningWatchStore } from './zoning-watch.store';

export const ZONING_STALE_ISSUE_TITLE = 'Zoning catalogue may be out of date';
export const ZONING_STALE_ISSUE_LABELS: readonly string[] = ['bug', 'agent:ready'];

export interface ZoningWatchResult {
  readonly skipped: boolean;
  readonly datasetChanged: boolean;
  readonly bylawChanged: boolean;
  readonly unknownDistrictCodes: readonly string[];
  /** Cached district lookups dropped by this run. */
  readonly cacheEntriesRefreshed: number;
  readonly issue: 'created' | 'commented' | 'already-reported' | 'no-token' | 'failed' | 'none';
  readonly stale: boolean;
}

export interface ZoningWatchService {
  /** One watch cycle (the daily timer). Throws only when the state can't be saved. */
  runCheck(): Promise<ZoningWatchResult>;
  /** Freshness of `catalogue` against the last detected City change. Never throws. */
  getFreshness(catalogue: ZoningDistrictsResponse): Promise<ZoningCatalogueFreshness>;
}

export interface ZoningWatchLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ZoningWatchServiceDeps {
  readonly config: ZoningWatchConfig & { readonly city: string; readonly freshnessCacheTtlMs: number };
  readonly zoning: Pick<ZoningService, 'getCatalogue' | 'resolve'>;
  readonly store: ZoningWatchStore;
  readonly cityDataCache: CityDataCacheInvalidator;
  /** Undefined when no GitHub token is configured. */
  readonly issues?: GitHubIssuesClient;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly logger?: ZoningWatchLogger;
}

// ── Pure helpers (unit-tested without I/O) ───────────────────────────────

/** Socrata `rowsUpdatedAt` (epoch seconds) → Date; null when unusable. */
export function parseRowsUpdatedAt(metadata: unknown): Date | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>)['rowsUpdatedAt'];
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/** `[{ lu_code }]` → sorted unique trimmed codes; null when not that shape. */
export function parseDistrictCodes(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null;
  const codes = new Set<string>();
  for (const row of body) {
    if (row === null || typeof row !== 'object') continue;
    const code = (row as Record<string, unknown>)['lu_code'];
    if (typeof code === 'string' && code.trim() !== '') codes.add(code.trim());
  }
  return [...codes].sort();
}

/**
 * Normalised page text for change detection: only the page's `<main>`
 * content (whole page when there is none), scripts/styles/tags removed,
 * whitespace collapsed — so a site-wide header/footer/alert banner, a
 * rotating script nonce or a markup tweak doesn't read as an amendment,
 * while any change to the words of the page body does.
 */
export function normalisePageText(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  return (main ? main[1]! : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Stale when the City changed rules after the catalogue, or has districts it lacks. */
export function isCatalogueStale(
  effectiveDate: string,
  state: Pick<ZoningWatchState, 'bylawChangedAt' | 'unknownDistrictCodes'> | undefined,
): boolean {
  if (!state) return false;
  if (state.unknownDistrictCodes.length > 0) return true;
  return state.bylawChangedAt !== null && isoDate(state.bylawChangedAt) > effectiveDate;
}

/**
 * ISO date of the latest City change the catalogue predates: a bylaw page
 * change after `effectiveDate`, or — for unknown district codes — the
 * dataset update that introduced them. Null when nothing is pending.
 */
export function latestChangeDetectedOn(
  effectiveDate: string,
  state: Pick<ZoningWatchState, 'bylawChangedAt' | 'unknownDistrictCodes' | 'datasetRowsUpdatedAt'> | undefined,
): string | null {
  if (!state) return null;
  const dates: string[] = [];
  if (state.bylawChangedAt && isoDate(state.bylawChangedAt) > effectiveDate) {
    dates.push(isoDate(state.bylawChangedAt));
  }
  if (state.unknownDistrictCodes.length > 0 && state.datasetRowsUpdatedAt) {
    dates.push(isoDate(state.datasetRowsUpdatedAt));
  }
  return dates.length > 0 ? dates.sort()[dates.length - 1]! : null;
}

/** Dedup key: the change being reported, not when it was seen. */
export function issueSignature(
  effectiveDate: string,
  bylawChangedAt: Date | null,
  unknownDistrictCodes: readonly string[],
): string {
  const bylaw = bylawChangedAt && isoDate(bylawChangedAt) > effectiveDate ? isoDate(bylawChangedAt) : '-';
  return sha256(`${effectiveDate}|${bylaw}|${unknownDistrictCodes.join(',')}`).slice(0, 16);
}

export function buildIssueBody(input: {
  catalogue: Pick<ZoningDistrictsResponse, 'city' | 'effectiveDate' | 'bylaw' | 'sourceUrl'>;
  bylawPageUrl: string;
  bylawChangedAt: Date | null;
  datasetRowsUpdatedAt: Date | null;
  unknownDistrictCodes: readonly string[];
  signature: string;
}): string {
  const { catalogue } = input;
  const lines = [
    `The daily zoning source watch (#757) detected City changes the \`${catalogue.city}\` zoning catalogue may not reflect.`,
    '',
    `- Catalogue: ${catalogue.bylaw}, rules as of **${catalogue.effectiveDate}** (\`packages/zoning/src/data/\`).`,
  ];
  if (input.bylawChangedAt && isoDate(input.bylawChangedAt) > catalogue.effectiveDate) {
    lines.push(
      `- Land Use Bylaw page changed on **${isoDate(input.bylawChangedAt)}**: ${input.bylawPageUrl}`,
    );
  }
  if (input.unknownDistrictCodes.length > 0) {
    lines.push(
      `- District codes in the City's Land Use Districts dataset that the catalogue doesn't know: ` +
        input.unknownDistrictCodes.map((c) => `\`${c}\``).join(', '),
    );
  }
  if (input.datasetRowsUpdatedAt) {
    lines.push(`- Land Use Districts dataset last updated ${input.datasetRowsUpdatedAt.toISOString()}.`);
  }
  lines.push(
    '',
    '## What to do',
    '1. Read the current bylaw text and amendments at the City source above.',
    '2. Add a new catalogue version (or update the current one) with section citations; mark only checked values `verified`.',
    '3. Until then the zoning panel shows "rules recently changed — confirm with the City".',
    '',
    `<!-- zoning-watch signature: ${input.signature} -->`,
  );
  return lines.join('\n');
}

// ── Service ──────────────────────────────────────────────────────────────

export function createZoningWatchService(deps: ZoningWatchServiceDeps): ZoningWatchService {
  const { config, store } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const logger: ZoningWatchLogger = deps.logger ?? { info: () => {}, warn: () => {} };
  const resourceUrl = `${config.socrataBaseUrl}/resource/${config.landUseDatasetId}.json`;
  const metadataUrl = `${config.socrataBaseUrl}/api/views/${config.landUseDatasetId}`;
  const codesUrl = `${resourceUrl}?$select=lu_code&$group=lu_code&$limit=50000`;
  let freshnessCache: { expires: number; state: ZoningWatchState | undefined } | undefined;

  /** GET with a timeout; undefined on any failure (never throws). */
  async function get(url: string, accept: string): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: accept } });
      return res.ok ? res : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(url: string): Promise<unknown> {
    try {
      return await (await get(url, 'application/json'))?.json();
    } catch {
      return undefined;
    }
  }

  async function getBylawPage(): Promise<{ hash: string; lastModified: Date | null } | undefined> {
    try {
      const res = await get(config.bylawPageUrl, 'text/html');
      if (!res) return undefined;
      const text = normalisePageText(await res.text());
      if (text === '') return undefined;
      const lm = res.headers.get('last-modified');
      const lastModified = lm ? new Date(lm) : null;
      return {
        hash: sha256(text),
        lastModified: lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified : null,
      };
    } catch {
      return undefined;
    }
  }

  async function report(
    body: string,
  ): Promise<{ outcome: ZoningWatchResult['issue']; url: string | null; recorded: boolean }> {
    if (!deps.issues) {
      logger.warn('zoning-watch: catalogue may be out of date, but no GitHub token is configured — no issue filed');
      return { outcome: 'no-token', url: null, recorded: false };
    }
    try {
      const open = await deps.issues.findOpenByTitle(ZONING_STALE_ISSUE_TITLE);
      if (open) {
        await deps.issues.comment(open.number, `New change detected since this issue was opened:\n\n${body}`);
        return { outcome: 'commented', url: open.url, recorded: true };
      }
      const created = await deps.issues.create({
        title: ZONING_STALE_ISSUE_TITLE,
        body,
        labels: ZONING_STALE_ISSUE_LABELS,
      });
      return { outcome: 'created', url: created.url, recorded: true };
    } catch (err) {
      logger.warn(`zoning-watch: filing the out-of-date issue failed (${err instanceof Error ? err.message : 'error'})`);
      return { outcome: 'failed', url: null, recorded: false };
    }
  }

  return {
    async runCheck(): Promise<ZoningWatchResult> {
      const catalogue = deps.zoning.getCatalogue();
      if (!config.enabled || !catalogue) {
        return {
          skipped: true,
          datasetChanged: false,
          bylawChanged: false,
          unknownDistrictCodes: [],
          cacheEntriesRefreshed: 0,
          issue: 'none',
          stale: false,
        };
      }
      const checkedAt = now();
      const [prev, metadata, codesBody, page] = await Promise.all([
        store.get(config.city),
        getJson(metadataUrl),
        getJson(codesUrl),
        getBylawPage(),
      ]);

      // 1. Dataset: refresh cached district lookups older than the City's update.
      const rowsUpdatedAt = parseRowsUpdatedAt(metadata);
      const prevRows = prev?.datasetRowsUpdatedAt ?? null;
      const datasetChanged =
        rowsUpdatedAt !== null && (prevRows === null || rowsUpdatedAt.getTime() > prevRows.getTime());
      let cacheEntriesRefreshed = 0;
      if (datasetChanged && rowsUpdatedAt) {
        try {
          cacheEntriesRefreshed = await deps.cityDataCache.invalidateDataset(
            config.landUseDatasetId,
            rowsUpdatedAt,
          );
        } catch {
          logger.warn('zoning-watch: refreshing cached districts failed; entries expire on their TTL');
        }
      }

      // 2. District codes the catalogue doesn't know (keep the last answer on failure).
      const codes = parseDistrictCodes(codesBody);
      const unknownDistrictCodes =
        codes === null
          ? (prev?.unknownDistrictCodes ?? [])
          : codes.filter((code) => deps.zoning.resolve(code).status === 'unknown');

      // 3. Bylaw page: a new hash is a detected amendment. The first
      //    sighting is only a baseline — a CMS Last-Modified alone is not
      //    evidence that the rules changed.
      let bylawPageHash = prev?.bylawPageHash ?? null;
      let bylawChangedAt = prev?.bylawChangedAt ?? null;
      let bylawChanged = false;
      if (page) {
        if (bylawPageHash !== null && page.hash !== bylawPageHash) {
          bylawChanged = true;
          bylawChangedAt = page.lastModified && page.lastModified > (bylawChangedAt ?? new Date(0))
            ? page.lastModified
            : checkedAt;
        }
        bylawPageHash = page.hash;
      }

      // 4. One issue per distinct change.
      const stale = isCatalogueStale(catalogue.effectiveDate, { bylawChangedAt, unknownDistrictCodes });
      let issue: ZoningWatchResult['issue'] = 'none';
      let signature = prev?.issueSignature ?? null;
      let issueUrl = prev?.issueUrl ?? null;
      if (stale) {
        const next = issueSignature(catalogue.effectiveDate, bylawChangedAt, unknownDistrictCodes);
        if (next === signature) {
          issue = 'already-reported';
        } else {
          const body = buildIssueBody({
            catalogue,
            bylawPageUrl: config.bylawPageUrl,
            bylawChangedAt,
            datasetRowsUpdatedAt: rowsUpdatedAt ?? prevRows,
            unknownDistrictCodes,
            signature: next,
          });
          const filed = await report(body);
          issue = filed.outcome;
          if (filed.recorded) {
            signature = next;
            issueUrl = filed.url;
          }
        }
      }

      const state: ZoningWatchState = {
        city: config.city,
        datasetRowsUpdatedAt: rowsUpdatedAt ?? prevRows,
        bylawPageHash,
        bylawChangedAt,
        unknownDistrictCodes,
        issueSignature: signature,
        issueUrl,
        checkedAt,
      };
      await store.put(state);
      freshnessCache = undefined;
      logger.info(
        `zoning-watch: dataset_changed=${datasetChanged} bylaw_changed=${bylawChanged} ` +
          `unknown_codes=${unknownDistrictCodes.length} refreshed=${cacheEntriesRefreshed} issue=${issue} stale=${stale}`,
      );
      return {
        skipped: false,
        datasetChanged,
        bylawChanged,
        unknownDistrictCodes,
        cacheEntriesRefreshed,
        issue,
        stale,
      };
    },

    async getFreshness(catalogue): Promise<ZoningCatalogueFreshness> {
      const t = Date.now();
      let state: ZoningWatchState | undefined;
      if (freshnessCache && t <= freshnessCache.expires) {
        state = freshnessCache.state;
      } else {
        try {
          state = await store.get(config.city);
          freshnessCache = { expires: t + config.freshnessCacheTtlMs, state };
        } catch {
          state = undefined; // fail-open, not cached: the next request retries
        }
      }
      return {
        rulesAsOf: catalogue.effectiveDate,
        stale: isCatalogueStale(catalogue.effectiveDate, state),
        latestChangeDetectedOn: latestChangeDetectedOn(catalogue.effectiveDate, state),
      };
    },
  };
}
