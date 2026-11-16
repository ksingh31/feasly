/**
 * Typed application configuration (BE0-002).
 *
 * Every tunable the API uses — connection strings, rate limits, token TTLs,
 * CORS origins, queue names — is declared here as a zod schema over the
 * environment. Missing or invalid env fails fast at startup with the variable
 * named, never a cryptic crash three layers deep.
 *
 * This module is the ONLY place allowed to touch `process.env` directly —
 * enforced by test/boundaries.test.ts. Everything else receives config
 * via constructor/factory injection. Likewise, literal URLs / timeouts /
 * limits in routes/, services/ or middleware/ fail the boundary test;
 * they belong here.
 *
 * `version` is derived from apps/api/package.json — the single source of
 * truth. Bump the package version; config follows automatically.
 */

import { z } from 'zod';
import { version as packageVersion } from '../package.json';
import { API_LEAD_CONSENT_VERSION, WAITLIST_CONSENT_VERSION } from './lib/legal-copy';
import {
  DEFAULT_DUNNING_GRACE_DAYS,
  MAX_DUNNING_GRACE_DAYS,
  MIN_DUNNING_GRACE_DAYS,
} from './lib/dunning-schedule';

export type NodeEnv = 'development' | 'test' | 'staging' | 'production';

/**
 * The protected super_admin seeded by migrations 0020/0036/0042 (and mirrored
 * in tools/repair-sql.mjs). The only runtime copy of this address in app code:
 * it backs the ops inbox/alert defaults, and tests import it rather than
 * repeating it. Allowlisted in tools/personal-id-allowlist.txt (#758).
 */
export const SEED_ADMIN_EMAIL = 'karanbirsingh667@gmail.com';

/** Split a comma-separated env value into a trimmed, non-empty list. */
/** #777: validated shape of NEIGHBOURHOOD_AMENITY_CATEGORIES. */
const amenityCategoriesSchema = z
  .array(
    z.object({
      key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'category key must be kebab-case'),
      label: z.string().min(1),
      datasetId: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/, 'datasetId must look like abcd-1234'),
      where: z.string().min(1).optional(),
      idField: z.string().min(1).optional(),
      nameField: z.string().min(1).optional(),
    }),
  )
  .min(1)
  .refine((list) => new Set(list.map((c) => c.key)).size === list.length, 'category keys must be unique')
  .refine((list) => list.every((c) => c.key !== 'tree-cover'), "'tree-cover' is reserved");

/**
 * #777: free City of Calgary open-data amenity categories (data.calgary.ca).
 * Overridable as JSON via NEIGHBOURHOOD_AMENITY_CATEGORIES.
 */
const DEFAULT_AMENITY_CATEGORIES = [
  {
    key: 'parks',
    label: 'Parks',
    datasetId: 'kami-qbfh', // Parks Sites
    where:
      "life_cycle_status='ACTIVE' AND planning_category in('REGIONAL PARK','DISTRICT PARK'," +
      "'COMMUNITY PARK','NEIGHBOURHOOD PARK','ATHLETIC PARK','LINEAR PARK')",
    idField: 'asset_cd',
    nameField: 'site_name',
  },
  {
    key: 'playgrounds',
    label: 'Playgrounds',
    // asset_cd is the park site: one playground per site.
    datasetId: 'bdu9-amk8', // Playground Equipment (multi-play complexes)
    where: "life_cycle_status='ACTIVE' AND type_description='MULTI PLAY COMPLEX'",
    idField: 'asset_cd',
  },
  {
    key: 'pathways',
    label: 'Pathways',
    // One point per segment; asset_cd is shared by many segments, so the id
    // is derived from location instead.
    datasetId: 'qndb-27qm', // Parks Pathways
    where: "life_cycle_status='ACTIVE'",
  },
  {
    key: 'rec-centres',
    label: 'Recreation centres',
    datasetId: 'hxfu-6d96', // Recreation Facilities
    where:
      "facility_type in('Leisure Centre','Leisure Centre - Municipal','Aquatic & Fitness Centre'," +
      "'Fieldhouse','Arena')",
    nameField: 'complex_name',
  },
  {
    key: 'pools',
    label: 'Pools',
    datasetId: 'hxfu-6d96', // Recreation Facilities
    where: "indr_pool='Y' OR outdr_pool='Y'",
    nameField: 'complex_name',
  },
  {
    key: 'libraries',
    label: 'Libraries',
    datasetId: 'x34e-bcjz', // Community Services
    where: "type='Library'",
    nameField: 'name',
  },
  {
    key: 'off-leash',
    label: 'Off-leash areas',
    datasetId: 'enr4-crti', // Parks Off Leash Areas
    where: "status='OPEN'",
    idField: 'off_leash_area_id',
    nameField: 'description',
  },
] as const;

function csvToList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** True when the runtime's Intl knows `zone` (rejects typos like "America/Edmonon"). */
function isIanaTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),

  // Primary: a full connection string. Fallback: the POSTGRES_* pieces the
  // Azure Function App sets (host/db/user from Bicep literals, password via
  // a Key Vault reference). DATABASE_URL wins when both are present.
  DATABASE_URL: z
    .string()
    .refine((value) => /^(postgres|postgresql):\/\//.test(value), {
      message: 'must be a Postgres connection string (postgres://… or postgresql://…)',
    })
    .optional(),
  POSTGRES_HOST: z.string().optional(),
  POSTGRES_DB: z.string().optional(),
  POSTGRES_USER: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),

  // Drizzle/pg pool ceiling per Functions instance.
  DB_POOL_MAX_SIZE: z.coerce.number().int().positive().default(5),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  // Safety valve: bounds the limiter's in-memory key map (DoS resistance).
  RATE_LIMIT_MAX_TRACKED_KEYS: z.coerce.number().int().positive().default(10_000),
  // #729: how often (per instance) the Postgres-backed shared limiter
  // deletes expired counter rows. Cleanup only — never affects a verdict.
  RATE_LIMIT_SHARED_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

  // The lead gate is public by design (callers are unauthenticated), so it
  // gets its own deliberately tight limiter — separate from the general one.
  LEAD_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  LEAD_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  // #788 invisible bot protection: the lead gate sends how long the form
  // was on screen (`elapsedMs`). A submission faster than this is
  // quarantined exactly like the honeypot (201, no email, no signal).
  // 0 disables the check. The threshold lives here — never in the web app.
  LEAD_MIN_SUBMIT_MS: z.coerce.number().int().nonnegative().default(2_000),

  // #788: Cloudflare Turnstile (managed/invisible) — required only from an
  // IP that tripped a shared money/mail rate limit, for BOT_CHALLENGE_WINDOW_MS
  // after the trip. Dormant until BOTH the site key (plain config) and the
  // secret (Key Vault reference) are set. Verification fails closed.
  TURNSTILE_SITE_KEY: z.string().trim().default(''),
  TURNSTILE_SECRET_KEY: z.string().trim().default(''),
  TURNSTILE_VERIFY_URL: z
    .string()
    .url()
    .default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  TURNSTILE_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  BOT_CHALLENGE_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  // Cap on outbound Turnstile verifications per tripped IP (#788 review):
  // junk tokens past this budget are denied without a siteverify call.
  BOT_CHALLENGE_VERIFY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  BOT_CHALLENGE_VERIFY_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),

  // Estimates are the most expensive endpoint to leave unthrottled. These
  // defaults are the FROZEN limits from the canonical API registry
  // (TECH_PLAN.md §13.3 "Rate limiting tiers": public-anon tier,
  // estimates 20/hr/IP) — env-overridable, never hardcoded per endpoint.
  // Embed traffic is additionally aggregated per tenant so one builder's
  // viral page can't starve the endpoint for everyone else.
  // #737: the per-tenant default was 20/hr, below the pilot's assumed 1x peak
  // of 50 estimates/hr (apps/api/loadtest/README.md traffic model), so one
  // builder's embed would have been throttled at normal traffic. It is now
  // 600/hr: the 10x target (500/hr) plus 20% headroom. Still a cap per
  // builder, so one viral page can't starve the endpoint.
  ESTIMATE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
  ESTIMATE_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  ESTIMATE_TENANT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
  ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(600),
  // Analytics ingest is public by design (story consumer/01), so it gets
  // its own limiter — generous (300/min per IP) but separate from the
  // general API traffic.
  ANALYTICS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  ANALYTICS_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),
  // #830 real-user-monitoring beacons: a real page load sends 1–2, and each
  // item becomes one App Insights trace, so the limiter is tight (10/min per
  // IP) and a per-instance trace budget caps the total — one client must not
  // be able to burn the 0.1 GB/day Log Analytics cap and blind server traces.
  WEB_TELEMETRY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  WEB_TELEMETRY_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  WEB_TELEMETRY_MAX_TRACES_PER_MINUTE: z.coerce.number().int().positive().default(60),

  /** #814: max utm_source × utm_campaign groups in the admin funnel breakdown. */
  FUNNEL_SOURCE_GROUP_LIMIT: z.coerce.number().int().positive().max(500).default(25),

  // Admin global search (⌘K palette): dedicated limiters — palettes fire
  // per keystroke, so they are separate from the general API budget.
  // Primary: per client IP, checked BEFORE the session token is looked at,
  // so rotating random Bearer tokens can't dodge throttling (300/min per
  // IP — generous enough for an office of admins behind one NAT).
  // Secondary: 60/min per session (frozen registry).
  ADMIN_SEARCH_IP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  ADMIN_SEARCH_IP_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),
  ADMIN_SEARCH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  ADMIN_SEARCH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
  /** Max hits returned per kind (leads, invoices, builders, users). */
  ADMIN_SEARCH_MAX_HITS_PER_KIND: z.coerce.number().int().positive().max(50).default(5),

  // Finance exports (#728): invoice CSVs run on their own limiters — per
  // client IP first (before any token is trusted), then 10/min per session
  // (frozen registry). An export larger than the row cap is refused with a
  // "narrow the date range" error instead of being silently truncated, so
  // CSV totals always match the summary panel.
  EXPORT_IP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  EXPORT_IP_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
  EXPORT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  EXPORT_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  EXPORT_MAX_ROWS: z.coerce.number().int().positive().max(100_000).default(10_000),
  /** Longest period an export or finance summary may cover, in days. */
  FINANCE_MAX_RANGE_DAYS: z.coerce.number().int().positive().max(3_660).default(366),

  // Stripe webhook receiver (billing/02): 100/min per IP (frozen registry).
  WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  WEBHOOK_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // Duplicate POSTs (same email + same estimate) inside this window return
  // the existing lead instead of inserting a duplicate (BE3-003).
  LEAD_DEDUP_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

  // Builder Leads home "Needs you" feed (issue #526): a contacted/quoted
  // lead with no status change for this many days counts as stale; the
  // feed scans at most this many of the builder's newest leads.
  LEAD_NEEDS_YOU_STALE_DAYS: z.coerce.number().int().positive().default(7),
  // #836: how far ahead (calendar days) a callback's preferred day may be.
  LEAD_CALLBACK_DATE_WINDOW_DAYS: z.coerce.number().int().positive().default(14),
  LEAD_NEEDS_YOU_SCAN_LIMIT: z.coerce.number().int().positive().default(500),

  // api-mcp/09: sandbox purge timer. Rows with sandbox=true older than
  // this are hard-deleted daily. DRY_RUN defaults true so the first run
  // only counts and logs — flip to false after verifying the blast radius.
  SANDBOX_PURGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  SANDBOX_PURGE_DRY_RUN: z.coerce.boolean().default(true),

  // #765 (go-live AC6/AC8): API-key auth posture.
  // AUTH_CACHE_TTL_SECONDS — per-instance cache of successful key lookups.
  // Capped at 60 so a revoked key is rejected on every instance within one
  // minute. 0 (default) = no cache: every request re-reads the key row.
  // ACCEPTED_MODES — which keys this deployment accepts: `all` (default —
  // live + sandbox side by side, sandbox writes flagged), `live` (a
  // production-only deployment rejects sandbox keys) or `sandbox` (a
  // sandbox-only deployment rejects live keys).
  API_KEY_AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(60).default(0),
  API_KEY_ACCEPTED_MODES: z.enum(['all', 'live', 'sandbox']).default('all'),

  // #703: one post-report follow-up email ("Questions about your
  // estimate?"), marketing-consent leads only. Off by default — flip per
  // environment once the copy is approved. DELAY_HOURS counts from the
  // first time the homeowner opened their report.
  FOLLOW_UP_EMAIL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  FOLLOW_UP_EMAIL_DELAY_HOURS: z.coerce.number().int().positive().default(72),

  // #838: Postgres-backed job queue (`jobs` table, claimed with FOR UPDATE
  // SKIP LOCKED by the job-queue timer). No new Azure resource. Failed jobs
  // retry with exponential backoff (BASE · 2^(attempt-1), capped at MAX)
  // and dead-letter after MAX_ATTEMPTS; a job claimed but not finished
  // within LOCK_TIMEOUT (worker crash) is reclaimed.
  JOB_QUEUE_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  JOB_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
  JOB_QUEUE_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(300),
  JOB_QUEUE_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().default(21_600),
  JOB_QUEUE_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  // #838: homeowner reminders (CASL consent only, through the queue).
  // UNFINISHED_DELAY_HOURS: gave an email but never opened the report.
  // MAX_PER_RUN caps how many reminders one scheduler run enqueues, per
  // reminder type (backpressure on the email provider).
  REMINDER_UNFINISHED_DELAY_HOURS: z.coerce.number().int().positive().default(24),
  REMINDER_MAX_PER_RUN: z.coerce.number().int().positive().max(5_000).default(500),
  // #838: link-only (copy-link) report shares — read-only, expiring,
  // revocable from the report page. TTL in seconds (default 7 days);
  // MAX_ACTIVE caps live links per report.
  SHARE_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  SHARE_LINK_MAX_ACTIVE: z.coerce.number().int().positive().max(50).default(5),

  // #725: builder notifications — one new-lead email per opted-in member
  // (send-once outbox, retried by the builder-notifications timer) and the
  // opt-in daily "Needs you" digest. ENABLED is the kill switch (default on:
  // owner decision 2026-11-15, new-lead email on for every member). The
  // digest goes out on the first timer tick at/after DIGEST_LOCAL_HOUR in
  // DIGEST_TIMEZONE (once per local day, deduped).
  BUILDER_NOTIFICATIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  BUILDER_NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  BUILDER_NOTIFICATION_RETRY_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  BUILDER_NOTIFICATION_CLAIM_LEASE_MINUTES: z.coerce.number().int().positive().default(10),
  BUILDER_DIGEST_LOCAL_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  BUILDER_DIGEST_TIMEZONE: z
    .string()
    .min(1)
    .refine(isIanaTimeZone, 'must be an IANA time zone, e.g. America/Edmonton')
    .default('America/Edmonton'),

  // #870: builder portal Settings. Support is email only (owner decision
  // 2026-11-15, #724): BUILDER_SUPPORT_EMAIL is unset until Karan names a
  // support address — until then builders are pointed at the team inbox
  // (OPS_INBOX_EMAIL), which is deliverable. RESPONSE_TIME is the promised
  // reply copy. The embed install check calls an origin "live" when the
  // widget loaded there within EMBED_LIVE_WINDOW_DAYS. The snippet's loader
  // URL is APP_BASE_URL + EMBED_LOADER_PATH (docs/embed-install.md).
  BUILDER_SUPPORT_EMAIL: z.string().trim().email().optional(),
  BUILDER_SUPPORT_RESPONSE_TIME: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default('within 1 business day'),
  BUILDER_EMBED_LIVE_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  BUILDER_EMBED_LOADER_PATH: z
    .string()
    .regex(/^\/[A-Za-z0-9._~/-]*$/, 'must be an absolute path, e.g. /embed/v1/loader.js')
    .default('/embed/v1/loader.js'),

  // neighbourhood/05: monthly community-stats refresh timer. Communities
  // with fewer fresh assessment records than this are skipped (logged, never
  // zero-filled). ALERT_AFTER_FAILURES consecutive timer failures fire the
  // community_stats_failed ops alert (admin/06).
  COMMUNITY_STATS_MIN_ASSESSMENTS: z.coerce.number().int().positive().default(10),
  COMMUNITY_STATS_ALERT_AFTER_FAILURES: z.coerce.number().int().positive().default(2),
  COMMUNITY_STATS_PRUNE_MIN_ROWS: z.coerce.number().int().positive().default(100),

  // #773: neighbourhood data (Community Match epic). Each outside source is
  // a provider interface; these pick the implementation (free now, paid
  // later — config-only switch). 'none' writes nothing and calls nothing.
  // #774: 'free-public' = City Schools + Alberta school authority list +
  // OpenStreetMap (private schools, websites); 'calgary-open-data' = City
  // Schools + authority list only (no OSM call).
  NEIGHBOURHOOD_SCHOOL_DIRECTORY_PROVIDER: z
    .enum(['free-public', 'calgary-open-data', 'none'])
    .default('free-public'),
  NEIGHBOURHOOD_SCHOOL_DESIGNATION_PROVIDER: z.enum(['none']).default('none'),
  NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER: z.enum(['none']).default('none'),
  NEIGHBOURHOOD_REVIEWS_PROVIDER: z.enum(['none']).default('none'),
  NEIGHBOURHOOD_AMENITIES_PROVIDER: z.enum(['calgary-open-data', 'none']).default('calgary-open-data'),
  NEIGHBOURHOOD_COMMUTE_PROVIDER: z.enum(['straight-line', 'none']).default('straight-line'),
  // City of Calgary open-data datasets behind the free implementations:
  // Schools, Community Services, Community Points.
  NEIGHBOURHOOD_SCHOOLS_DATASET_ID: z.string().min(1).default('fd9t-tdn2'),
  // #777: amenity categories (key, label, City dataset, SoQL filter) as a
  // JSON array — adding/removing a category is config-only. See
  // DEFAULT_AMENITY_CATEGORIES for the shape and the free defaults.
  NEIGHBOURHOOD_AMENITY_CATEGORIES: z
    .string()
    .min(2)
    .default(JSON.stringify(DEFAULT_AMENITY_CATEGORIES))
    .transform((raw, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be a JSON array' });
        return z.NEVER;
      }
      const result = amenityCategoriesSchema.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({ code: 'custom', message: result.error.issues[0]?.message ?? 'invalid' });
        return z.NEVER;
      }
      return result.data;
    }),
  // #777: per-community public-tree cover: City "Public Trees" (counted per
  // community) over the community's area from "Community District
  // Boundaries". Level thresholds are public trees per hectare
  // ("low,high": below low = low, at/above high = high, else moderate).
  NEIGHBOURHOOD_PUBLIC_TREES_DATASET_ID: z.string().min(1).default('tfs4-3wwa'),
  // Also #774: each school's community code is a point-in-polygon test against these.
  NEIGHBOURHOOD_COMMUNITY_BOUNDARIES_DATASET_ID: z.string().min(1).default('surr-xmvs'),
  NEIGHBOURHOOD_TREE_COVER_THRESHOLDS: z
    .string()
    .default('11,16')
    .transform((raw) => csvToList(raw).map(Number))
    .pipe(z.array(z.number().positive()).length(2))
    .refine(([low, high]) => low! < high!, 'low threshold must be below high'),
  // #777: community amenity metrics — nearest within the search radius and
  // counts within each radius (metres, from the community centre).
  NEIGHBOURHOOD_AMENITY_SEARCH_RADIUS_M: z.coerce.number().int().positive().default(3_000),
  NEIGHBOURHOOD_AMENITY_COUNT_RADII_M: z
    .string()
    .default('500,1000')
    .transform((raw) => csvToList(raw).map(Number))
    .pipe(z.array(z.number().int().positive()).min(1)),
  // How long computed community metrics are reused from the shared cache.
  NEIGHBOURHOOD_COMMUNITY_METRICS_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  NEIGHBOURHOOD_COMMUNITY_POINTS_DATASET_ID: z.string().min(1).default('j9ps-fyst'),
  // #774: OpenStreetMap Overpass endpoint and the Calgary bounding box
  // (south,west,north,east) queried for amenity=school.
  NEIGHBOURHOOD_OSM_OVERPASS_URL: z.string().url().default('https://overpass-api.de/api/interpreter'),
  NEIGHBOURHOOD_OSM_BBOX: z
    .string()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
    .default('50.84,-114.32,51.22,-113.85'),
  // #774: an OSM school within this distance of a City school with a
  // matching name is the same school (de-duplicated, fields merged).
  // Overpass answers city-wide queries slowly; its own (longer) timeout.
  NEIGHBOURHOOD_OSM_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  NEIGHBOURHOOD_SCHOOL_DEDUPE_RADIUS_M: z.coerce.number().int().positive().default(300),
  // Established infill communities only (#690 rule): residential
  // communities whose City "community structure" is one of these.
  NEIGHBOURHOOD_COMMUNITY_CLASS: z.string().min(1).default('Residential'),
  NEIGHBOURHOOD_COMMUNITY_STRUCTURES: z.string().min(1).default('INNER CITY,1950s,1960s/1970s'),
  // Straight-line commute reference point (downtown core, City Hall).
  NEIGHBOURHOOD_COMMUTE_DESTINATION_NAME: z.string().min(1).default('Downtown'),
  NEIGHBOURHOOD_COMMUTE_DESTINATION_LAT: z.coerce.number().min(-90).max(90).default(51.0453),
  NEIGHBOURHOOD_COMMUTE_DESTINATION_LNG: z.coerce.number().min(-180).max(180).default(-114.0581),
  NEIGHBOURHOOD_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Upper bound on rows fetched per dataset in one refresh.
  NEIGHBOURHOOD_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
  // Monthly schedule: a provider is due once its last success predates
  // 00:00 UTC on this day of the current month. The timer ticks daily so a
  // failed or interrupted run resumes the next day.
  NEIGHBOURHOOD_REFRESH_DAY_OF_MONTH: z.coerce.number().int().min(1).max(28).default(1),
  // One ops alert once a provider has been failing this many days.
  NEIGHBOURHOOD_ALERT_AFTER_FAILURE_DAYS: z.coerce.number().int().positive().default(3),
  // Per-address metrics: search radius, and how long a computed row is reused.
  NEIGHBOURHOOD_LOT_RADIUS_M: z.coerce.number().int().positive().default(1_000),
  NEIGHBOURHOOD_LOT_METRICS_TTL_MS: z.coerce.number().int().positive().default(2_592_000_000),

  // JWT session lifetime is provisional — Karan has not confirmed magic-link-only V1
  // or the session lifetime. Revisit when the login ADR lands (BE-4).
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  // Magic-link lifetime decided by Karan 2026-09-24: 7 days (604_800 s).
  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  // HRD-03: per-email cooldown between magic-link resend emails. The reissue
  // endpoint already refuses to send while a live link exists; this covers
  // the residual case (revoked/expired link + immediate re-request) so one
  // address can't be mail-bombed faster than this.
  MAGIC_LINK_REISSUE_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
  // P1-6 (2026-09-30 security audit): the registry claimed "5/hr per
  // email+IP" on the magic-link reissue and builder-auth request endpoints,
  // but only the 100/min/IP pipeline and the 60s reissue cooldown existed —
  // an email-bombing vector against any known address. This caps actual
  // magic-link *sends* per normalized email per rolling hour on both paths.
  MAGIC_LINK_MAX_SENDS_PER_HOUR: z.coerce.number().int().positive().default(5),
  // #806: lifetime of the owner link minted for the erase-confirmation email
  // (POST /privacy/erase-requests). Short on purpose — it only has to survive
  // the trip to the inbox and one click. Default 24 h.
  PRIVACY_ERASE_CONFIRM_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  // EMB-06: relay-code lifetime (10 minutes per story) and the session-token
  // lifetime it exchanges into (12 hours per story). Both from env so tests
  // and staging can shorten them without code changes.
  EMBED_RELAY_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  EMBED_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  // EMB-06 AC3: per-code resend cooldown (60 seconds per story) so the
  // "session expired" re-issue button can't be hammered into a code fountain.
  EMBED_RELAY_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  // #740 (owner consent decision 2026-11-15): version tag of the CASL waitlist
  // consent wording stored in waitlist_signups.consent_version. Defaults to the
  // tag in lib/legal-copy.ts; override per environment without a code change.
  WAITLIST_CONSENT_VERSION: z.string().trim().min(1).default(WAITLIST_CONSENT_VERSION),
  // #738 (owner decision 2026-11-15, invite-only free beta): per-API-key
  // usage quotas on top of the per-minute limit. Counted from the api_usage
  // table per UTC calendar day / month, so they hold across instances.
  API_KEY_DAILY_QUOTA: z.coerce.number().int().positive().default(100),
  API_KEY_MONTHLY_QUOTA: z.coerce.number().int().positive().default(2_000),
  // #738: consent-attestation version an API caller must send with a lead
  // (`consentVersion`). Defaults to the tag in lib/legal-copy.ts.
  API_LEAD_CONSENT_VERSION: z.string().trim().min(1).default(API_LEAD_CONSENT_VERSION),
  // #738: leads submitted with an API key land in the admin quarantine
  // queue for review (no magic-link email until approved). Beta default on.
  API_KEY_LEADS_QUARANTINE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // INTERIM (api-mcp/01): pre-shared key for admin endpoints until
  // admin/01's session auth lands. Unset = admin endpoints fail closed.
  ADMIN_API_KEY: z.string().trim().min(1).optional(),
  // Admin session ABSOLUTE lifetime (#730, owner decision 2026-11-15): 12 h.
  // Was 7 days (admin/01, D-02). Also caps rows minted under the old value.
  ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  // #730: admin IDLE timeout — a session unused for this long stops
  // validating (1 h, owner decision 2026-11-15).
  ADMIN_SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3_600),
  // #730: builder session absolute lifetime (7 days) and idle timeout (24 h),
  // owner decision 2026-11-15. Builders previously shared the admin TTL.
  BUILDER_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  BUILDER_SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(86_400),
  // #730: how often (at most) a validated session's last_seen_at is written.
  // Bounds the write load of activity tracking; the idle timeout is accurate
  // to within this interval.
  SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  // #730: dangerous actions (view-as, mark-paid, user deactivation, API-key
  // issuance/rotation) require a sign-in no older than this; otherwise
  // 401 REAUTH_REQUIRED and the user signs in again.
  SESSION_REAUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(1_800),
  // auth/01: invitation lifetime — 7 days, same discipline as the
  // magic links it replaces.
  INVITATION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  // auth/01 (Entra pivot): Microsoft Entra External ID — the tenant that
  // owns staff/builder credentials. All optional: the tenant is being
  // created in parallel, so the EntraUserService fails closed with a clear
  // error when called before these are set. The client secret lives in Key
  // Vault in Azure (plain env locally); it is never logged or emailed.
  ENTRA_TENANT_ID: z.string().default(''),
  ENTRA_GRAPH_CLIENT_ID: z.string().default(''),
  ENTRA_GRAPH_CLIENT_SECRET: z.string().default(''),
  // Issuer domain for the email sign-in identity, e.g.
  // feaslyexternal.onmicrosoft.com (from the tenant's domain list).
  ENTRA_ISSUER_DOMAIN: z.string().default(''),

  // --- Microsoft Entra External ID (auth/02) ---
  // PLACEHOLDER values until AUTH-00 provisions the tenant (tenant subdomain,
  // tenant id, `feasly-web` client id, sign-in user flow). Empty = the Entra
  // callback fails closed with 503 naming the missing variable. Real values
  // arrive via app settings / Key Vault references — never in the repo.
  // (Allowlisted: tools/placeholder-allowlist.txt.)
  ENTRA_TENANT_SUBDOMAIN: z.string().trim().default(''),
  ENTRA_CLIENT_ID: z.string().trim().default(''),
  ENTRA_USER_FLOW: z.string().trim().default(''),
  // Client secret for the `feasly-web` app registration. The callback
  // redirect URI is registered on the "Web" platform, so the token endpoint
  // treats the backend as a confidential client and demands client
  // authentication (HTTP 401 invalid_client without it). Lives in Key Vault
  // in Azure (plain env locally); it is never logged or emailed.
  ENTRA_CLIENT_SECRET: z.string().default(''),
  // JWKS cache TTL (ms). Entra rotates signing keys infrequently; a short
  // cache bounds both fetch latency and staleness after a rotation.
  ENTRA_JWKS_CACHE_TTL_MS: z.coerce.number().int().positive().default(600_000),
  // HTTP timeout (ms) for the Entra token/JWKS calls — a hanging IdP must
  // not hang the sign-in request.
  ENTRA_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Callback rate limit (frozen registry): 10 attempts per IP per 15 min.
  ENTRA_CALLBACK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  ENTRA_CALLBACK_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),

  // ── Builder Entra External ID sign-in (auth/05) ──────────────────────
  // Separate app registration / user flow for the builder portal.
  // PLACEHOLDER (2026-09-28): not yet provisioned in the Azure portal —
  // the builder callback 503s fail-closed until Karan provisions it
  // (same manual-portal pattern as the admin flow, AUTH-00).
  BUILDER_ENTRA_TENANT_SUBDOMAIN: z.string().trim().default(''),
  BUILDER_ENTRA_TENANT_ID: z.string().trim().default(''),
  BUILDER_ENTRA_CLIENT_ID: z.string().trim().default(''),
  BUILDER_ENTRA_USER_FLOW: z.string().trim().default(''),
  BUILDER_ENTRA_CLIENT_SECRET: z.string().default(''),

  // A hanging dependency must not hang the health endpoint (BE0-003).
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform(csvToList),
  // Public site URL — used as the production `servers` entry in the
  // OpenAPI spec (api-mcp/03). Defaults to the dev-site placeholder.
  SITE_URL: z.string().url().default('https://feasly.dev'),
  QUEUE_EMAIL_NAME: z.string().min(1).default('email-queue'),
  QUEUE_PDF_NAME: z.string().min(1).default('pdf-queue'),
  QUEUE_SHEETS_NAME: z.string().min(1).default('sheets-queue'),

  // --- Google Sheets sync (admin/04) ---
  // Destination Sheet ID — placeholder until Karan shares his Sheet with the
  // service account. Empty = sync disabled (worker fails closed, alert fires).
  SHEETS_SHEET_ID: z.string().default(''),
  // --- AI narrative worker (consumer/06) ---
  // Narrative LLM provider: 'log' = dev/test console transport (default,
  // refuses production); 'openai-compatible' = any OpenAI-protocol
  // chat-completions endpoint (Gemini today, Groq/OpenAI later — Karan's pick).
  NARRATIVE_PROVIDER: z.enum(['log', 'openai-compatible']).default('log'),
  // LLM API key (Gemini) — from Key Vault, never in repo/env files. Empty
  // with provider='openai-compatible' = fail-closed generation naming this var.
  NARRATIVE_API_KEY: z.string().default(''),
  // LLM model for narratives. Default is Gemini 3.8 Flash — the model
  // in Karan's Google project (verified 2026-09-28 against the Gemini
  // dashboard and ai.google.dev OpenAI-compat docs; the old
  // gemini-2.5-flash / gemini-2.5-flash-lite IDs return HTTP 404).
  // Overridable without a code change.
  /**
   * Ordered narrative model list, primary first — config-owned so Karan
   * can reorder or swap models without a code change. The provider tries
   * the next model on capacity errors (408/429/5xx), timeouts, and
   * network failures, and fails fast on other 4xx.
   */
  NARRATIVE_MODELS: z.string().default('gemini-3.8-flash'),
  /** Per-attempt timeout (ms) for each model in the narrative chain. */
  NARRATIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Base URL of the OpenAI-compatible endpoint. Overridable for tests;
  // default is Google's Gemini OpenAI-compatibility base. The provider
  // appends /chat/completions when the value does not already end with it.
  NARRATIVE_ENDPOINT: z.string().default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  // --- Fallback narrative provider (Groq, OpenAI-compatible) ---
  // Tried after the primary (Gemini) chain is exhausted on capacity
  // errors (408/429/5xx), timeouts, or network failures. Base URL of the
  // fallback endpoint; default is Groq's OpenAI-compatibility base.
  NARRATIVE_FALLBACK_ENDPOINT: z.string().default('https://api.groq.com/openai/v1'),
  // Fallback LLM API key (Groq) — from Key Vault, never in repo/env
  // files. Empty = the Groq step is skipped gracefully (logged, key
  // never logged); the static guide remains the last resort. Karan
  // provisions the key in Key Vault himself (free signup, no card).
  NARRATIVE_FALLBACK_API_KEY: z.string().default(''),
  // Comma-separated fallback model list, primary first. Default is
  // OpenAI gpt-oss-120b via Groq — Groq's official replacement for the
  // retired llama-3.3-70b-versatile (retired 2026-08-16; current per
  // console.groq.com/docs/models as of 2026-09-28). Overridable without
  // a code change.
  NARRATIVE_FALLBACK_MODELS: z.string().default('openai/gpt-oss-120b'),
  // --- Monthly community narratives (#759) ---
  // One stored LLM narrative per community per month, reused by every
  // report (no LLM call per estimate). Off switch for the timer + admin
  // regenerate; reports still read whatever is stored.
  COMMUNITY_NARRATIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // NCRONTAB tick for the community-narrative timer. Must equal the
  // schedule in community-narrative-timer/function.json (pinned by test).
  // Daily: the service decides whether today is the run day or a retry day.
  COMMUNITY_NARRATIVE_SCHEDULE: z.string().min(1).default('0 0 9 * * *'),
  // Day of the month the job generates next month's narratives:
  // 'last' (owner decision) or a fixed day 1-28.
  COMMUNITY_NARRATIVE_RUN_DAY: z
    .string()
    .regex(/^(last|[1-9]|1\d|2[0-8])$/, "use 'last' or a day 1-28")
    .default('last'),
  // Daily ticks after the run day that retry failed communities before
  // one ops alert fires.
  COMMUNITY_NARRATIVE_RETRY_DAYS: z.coerce.number().int().min(0).max(10).default(3),
  // Comma-separated model list for community narratives; empty = reuse
  // NARRATIVE_MODELS.
  COMMUNITY_NARRATIVE_MODELS: z.string().default(''),
  // Prompt version stamped on every stored narrative (bump on prompt edits).
  COMMUNITY_NARRATIVE_PROMPT_VERSION: z.string().min(1).default('community-v1'),
  // Cost guard: max LLM generations per timer tick / admin request.
  COMMUNITY_NARRATIVE_MAX_PER_RUN: z.coerce.number().int().positive().default(400),
  // Wall-clock budget (ms) for an admin "regenerate all" request; the rest
  // is left 'stale' and finished by the next daily tick.
  COMMUNITY_NARRATIVE_ADMIN_BUDGET_MS: z.coerce.number().int().positive().default(60_000),
  // Wall-clock budget (ms) for one timer tick, kept well under the 30 min
  // Functions host timeout so the run event and the retry-day alert check
  // always run; whatever is left is picked up by the next daily tick.
  COMMUNITY_NARRATIVE_TICK_BUDGET_MS: z.coerce.number().int().positive().default(1_200_000),
  // Service-account email — placeholder until provisioned in Key Vault.
  // Empty = sync disabled (worker fails closed, alert fires).
  SHEETS_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
  // Service-account private key — from Key Vault, never in repo/env files.
  // Empty = sync disabled (worker fails closed, alert fires).
  SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().default(''),
  // Max leads per hourly sync run (backpressure). Default 500.
  SHEETS_MAX_LEADS_PER_RUN: z.coerce.number().int().positive().default(500),
  // Hours without a successful sync before the ops panel (admin/05) calls
  // the worker "lagging". Default 2 (story AC2).
  SHEETS_LAG_AFTER_HOURS: z.coerce.number().int().positive().default(2),
  // A 'running' sync run older than this is treated as stale (crashed
  // instance), not in flight — manual "Sync now" is allowed again.
  SHEETS_RUN_STALE_AFTER_MIN: z.coerce.number().int().positive().default(30),
  // Google Sheets API OAuth scope. Not a secret, but config keeps it out of code.
  SHEETS_API_SCOPE: z
    .string()
    .url()
    .default('https://www.googleapis.com/auth/spreadsheets'),

  // Reno rates are uncalibrated draft placeholders (RENO-01). Renovation
  // estimates are refused unless this is true — and production refuses to
  // boot on draft data even then (see composition.ts). Set it in dev only.
  COST_ENGINE_ALLOW_DRAFT: z.coerce.boolean().default(false),

  // --- Property data (City of Calgary Socrata) ---
  // Public open-data API — no key required. Anonymous requests are
  // rate-limited per IP, so the property service caches responses.
  SOCRATA_BASE_URL: z.string().url().default('https://data.calgary.ca'),
  SOCRATA_DATASET_ID: z.string().min(1).default('4bsw-nn7w'),
  PROPERTY_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  PROPERTY_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PROPERTY_SEARCH_ROW_LIMIT: z.coerce.number().int().positive().default(50),
  PROPERTY_SUGGESTION_LIMIT: z.coerce.number().int().positive().default(8),
  // #755: market rule — homes this many years old (or older, by the City's
  // year of construction) are redevelopment candidates; younger homes are
  // steered to renovation. Per market, so other cities can differ.
  PROPERTY_REDEVELOPMENT_MIN_AGE_YEARS: z.coerce.number().int().positive().default(25),
  // --- Shared City-data cache (#756) ---
  // Durable (Postgres) cache of City records, shared by every instance and
  // every route. Per-dataset TTLs follow the City's refresh cadence: the
  // assessment roll is published yearly (with occasional corrections), the
  // Land Use Districts map changes on bylaw amendments (dataset updated weekly).
  PROPERTY_DB_CACHE_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  LAND_USE_DB_CACHE_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  // Cap on a cache read/write so a slow database never slows a lookup; on
  // timeout the lookup goes to the City as before.
  PROPERTY_DB_CACHE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
  // Browser/HTTP cache lifetime on property GETs (lookup + autocomplete).
  PROPERTY_HTTP_CACHE_MAX_AGE_S: z.coerce.number().int().nonnegative().default(3_600),
  // --- Current land-use district (#686) ---
  // The assessment roll's land_use_designation is stale after the 2024
  // rezoning repeal (pre-repeal pairs like "R-C2,R-CG"). The current district
  // comes from the City's Land Use Districts dataset (updated weekly). The
  // provider is chosen per city; 'assessment-roll' disables the lookup.
  LAND_USE_PROVIDER: z
    .enum(['calgary-land-use-districts', 'assessment-roll'])
    .default('calgary-land-use-districts'),
  LAND_USE_DATASET_ID: z.string().min(1).default('qe6k-p9nh'),
  LAND_USE_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  // Hard cap on what the district lookup can add to a property lookup (p95).
  LAND_USE_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  // --- Zoning rules catalogue (#687) ---
  // Which city's catalogue GET /api/v1/zoning/districts serves (a key in
  // @feasly/zoning ZONING_CATALOGUES). Adding a city = data file + this value.
  ZONING_CITY: z.string().trim().toLowerCase().min(1).default('calgary'),
  // Cache-Control max-age for the catalogue (static per deploy; 1h default).
  ZONING_CACHE_MAX_AGE_S: z.coerce.number().int().nonnegative().default(3_600),
  // --- Zoning source watch (#757) ---
  // Daily timer: compares the City's Land Use Districts dataset metadata and
  // the Land Use Bylaw page with what it last saw; on a change it refreshes
  // cached districts and files one "Zoning catalogue may be out of date"
  // issue. Free sources only (City open data + GitHub REST).
  ZONING_WATCH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ZONING_BYLAW_WATCH_URL: z
    .string()
    .url()
    .default(
      'https://www.calgary.ca/pda/pd/calgary-land-use-bylaw-1p2007/calgary-land-use-bylaw-1p2007.html',
    ),
  ZONING_WATCH_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // How long GET /zoning/districts reuses the watch state before re-reading it.
  ZONING_FRESHNESS_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),
  // Where the "catalogue may be out of date" issue is filed. The token is a
  // Key Vault reference app setting (issues:write on this repo only); empty
  // = detect and record, but file no issue (logged).
  ZONING_WATCH_GITHUB_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .default('ksingh31/feasly'),
  ZONING_WATCH_GITHUB_TOKEN: z.string().default(''),
  ZONING_WATCH_GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  // --- Builder partner disclosure (#888) ---
  // In-memory TTL for the public active-partner list (admin writes on the
  // same instance invalidate it at once; other instances within this TTL).
  PARTNERS_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),
  // Cache-Control max-age on GET /api/v1/partners (5 min default).
  PARTNERS_CACHE_MAX_AGE_S: z.coerce.number().int().nonnegative().default(300),
  // --- Community lot inventory (#691) ---
  // Vacant residential land-only parcels in established infill communities
  // (owner decision 2026-11-15: infill only, same rule as #690 — community
  // boundary class + structure from the City's Community District
  // Boundaries dataset). Shares SOCRATA_BASE_URL + SOCRATA_DATASET_ID
  // (assessments) and LAND_USE_* (current district) with property lookup.
  COMMUNITY_LOTS_CITY: z.string().trim().toLowerCase().min(1).default('calgary'),
  COMMUNITY_LOTS_BOUNDARIES_DATASET_ID: z.string().min(1).default('surr-xmvs'),
  COMMUNITY_LOTS_ESTABLISHED_CLASSES: z.string().default('Residential').transform(csvToList),
  COMMUNITY_LOTS_ESTABLISHED_STRUCTURES: z
    .string()
    .default('INNER CITY,1950s,1960s/1970s')
    .transform(csvToList),
  // Sliver guard: remnant strips below this lot area are not lots (0 = off).
  COMMUNITY_LOTS_MIN_LOT_SQFT: z.coerce.number().int().nonnegative().default(1_000),
  // Current districts that qualify (case-insensitive prefixes): low-density
  // residential (R-*) and grade-oriented infill (H-GO). Multi-residential,
  // mixed-use, commercial, Direct Control and special-purpose are excluded.
  COMMUNITY_LOTS_ALLOWED_DISTRICT_PREFIXES: z.string().default('R-,H-GO').transform(csvToList),
  // Socrata paging + politeness: rows per page, pause between requests,
  // concurrent district lookups, per-request timeout.
  COMMUNITY_LOTS_PAGE_SIZE: z.coerce.number().int().positive().max(50_000).default(1_000),
  COMMUNITY_LOTS_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(100),
  COMMUNITY_LOTS_DISTRICT_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),
  COMMUNITY_LOTS_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Retries per Socrata request (district lookup or page) before the
  // community is reported failed and its stored lots are kept.
  COMMUNITY_LOTS_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  // Lots older than this are flagged `stale` and fail the freshness check.
  // Weekly refresh (matches the Land Use Districts dataset) + slack.
  COMMUNITY_LOTS_STALE_AFTER_DAYS: z.coerce.number().int().positive().default(14),
  // Consecutive failed refreshes before the community_lots_failed ops alert.
  COMMUNITY_LOTS_ALERT_AFTER_FAILURES: z.coerce.number().int().positive().default(1),
  // List page size: default and hard cap.
  COMMUNITY_LOTS_DEFAULT_LIMIT: z.coerce.number().int().positive().default(50),
  COMMUNITY_LOTS_MAX_LIMIT: z.coerce.number().int().positive().default(200),
  // Cache-Control max-age on the public list (data changes weekly).
  COMMUNITY_LOTS_CACHE_MAX_AGE_S: z.coerce.number().int().nonnegative().default(3_600),
  // --- City-data freshness (landing trust strip) ---
  // Shares the SOCRATA_* source with propertyData; its own TTL because the
  // metadata changes at most monthly (24h default, successful fetches only).
  CITY_DATA_FRESHNESS_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  // --- Billing foundation (story billing/01) ---
  // Karan's decision 2026-09-24: 1% of signed construction contract value
  // (excl. land), config-switchable to flat. The billing ENGINE (charging,
  // payouts, dashboard) waits on api-mcp/08 + embed/09 — this story only
  // lands the config schema, attribution tracking, and SLA deadlines.
  // Switching models is a config change, never a code change.
  BILLING_MODEL: z.enum(['commission', 'flat']).default('commission'),
  // Commission rate as a fraction: 0.01 = 1%.
  BILLING_COMMISSION_RATE: z.coerce.number().positive().max(1).default(0.01),
  // Attribution window: introduction → signed contract (12 months).
  BILLING_ATTRIBUTION_WINDOW_DAYS: z.coerce.number().int().positive().default(365),
  // Builder reporting SLA: days from contract signature to report it.
  BILLING_REPORTING_SLA_DAYS: z.coerce.number().int().positive().default(14),
  // Max off-session charge retries per failed commission invoice (BILL-03).
  BILLING_MAX_CHARGE_RETRIES: z.coerce.number().int().min(1).default(3),
  // #711: an invoice 'finalized' (charge in progress) longer than this is
  // reconciled against Stripe by the daily reviewer and flagged on
  // /admin/webhooks. 24h default (open owner question on #711 — tunable).
  BILLING_SETTLEMENT_THRESHOLD_HOURS: z.coerce.number().int().positive().default(24),
  // #718 dunning: default per-invoice grace period in days (admin can edit
  // it per invoice). Card invoices: days between a failed charge and the
  // next automatic retry. Manual-method invoices: days after the review
  // window closes before the invoice is overdue. 7 matches the "update your
  // card within 7 days" copy the declined email already carried.
  BILLING_DUNNING_GRACE_DAYS: z.coerce
    .number()
    .int()
    .min(MIN_DUNNING_GRACE_DAYS)
    .max(MAX_DUNNING_GRACE_DAYS)
    .default(DEFAULT_DUNNING_GRACE_DAYS),
  // --- Card lifecycle (#716) ---
  // Text on the builder's bank statement for a commission charge. Sent as
  // Stripe's statement_descriptor_suffix (card PaymentIntents reject a full
  // statement_descriptor). Stripe rules: at most 22 characters, at least one
  // letter, none of < > \ ' " *. Unset → the Stripe account default.
  BILLING_STATEMENT_DESCRIPTOR: z
    .string()
    .trim()
    .min(1)
    .max(22)
    .regex(/^[^<>\\'"*]+$/, 'must not contain < > \\ \' " *')
    .regex(/[A-Za-z]/, 'must contain at least one letter')
    .optional(),
  // Days before a saved card's expiry month ends that the portal shows
  // "expires soon" on the card on file.
  BILLING_CARD_EXPIRY_WARNING_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // --- Sales tax on commission invoices (#714) ---
  // Owner decision 2026-11-15: Feasly bills through the owner's existing
  // company; GST at 5%, shown as its own line, priced "commission plus GST"
  // (tax-exclusive) by default. OFF by default so every figure matches the
  // pre-tax output until the registration number is configured; production
  // refuses to start with tax ON and any supplier detail still a placeholder.
  BILLING_TAX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Tax rate as a fraction: 0.05 = 5% GST (Alberta).
  BILLING_TAX_RATE: z.coerce.number().min(0).max(1).default(0.05),
  BILLING_TAX_LABEL: z.string().trim().min(1).max(32).default('GST'),
  // 'false' = commission plus tax (default); 'true' = commission includes tax.
  BILLING_TAX_INCLUSIVE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Supplier details printed on tax invoices. Placeholders until the owner
  // supplies them (tools/placeholder-allowlist.txt, docs/launch-checklist.md).
  BILLING_SUPPLIER_LEGAL_NAME: z.string().trim().min(1).default('PLACEHOLDER_SUPPLIER_LEGAL_NAME'),
  BILLING_SUPPLIER_ADDRESS: z.string().trim().min(1).default('PLACEHOLDER_SUPPLIER_ADDRESS'),
  BILLING_TAX_REGISTRATION_NUMBER: z.string().trim().min(1).default('PLACEHOLDER_GST_NUMBER'),
  // Flat-plan fields — dormant until BILLING_MODEL=flat.
  BILLING_FLAT_PLAN_NAME: z.string().min(1).default('Builder Standard'),
  BILLING_FLAT_MONTHLY_CENTS: z.coerce.number().int().positive().default(30_000),
  BILLING_FLAT_CURRENCY: z
    .string()
    .length(3)
    .default('CAD')
    .transform((code) => code.toUpperCase()),
  // --- Stripe (story billing/02 commission engine) ---
  // Secret key is OPTIONAL: billing stays dormant until a key is configured.
  // Test-mode enforcement (Karan's "no real charges in dev/staging"): when
  // set, a non-production env REQUIRES an sk_test_ key and production
  // REQUIRES an sk_live_ key — enforced at startup, not at charge time.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  // Webhook signing secret — required to run the webhook route, fail-fast
  // at call time when absent.
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Flat-plan Stripe Price id (`price_…`) — only used when BILLING_MODEL=flat.
  STRIPE_FLAT_PRICE_ID: z.string().min(1).optional(),
  // --- Payment provider (#753) ---
  // `simulated` = Stripe-shaped simulation (test cards, signed webhook
  // events through the production handler, no real money). `stripe` = the
  // Stripe SDK with STRIPE_* secrets. Unset → `simulated` in development,
  // `stripe` everywhere else. Production refuses to boot with `simulated`.
  PAYMENTS_PROVIDER: z.enum(['simulated', 'stripe']).optional(),
  // Signing secret for simulated webhook events. Optional: unset → a random
  // per-process secret (events are signed and verified in the same process
  // at delivery time). Not a real credential — it can never move money.
  PAYMENTS_SIMULATED_WEBHOOK_SECRET: z.string().min(16).optional(),
  // How long after a simulated charge its webhook is delivered (Stripe's
  // webhooks are asynchronous too). Undelivered events are also flushed on
  // the next simulated payment call.
  PAYMENTS_SIMULATED_WEBHOOK_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(1_500),

  // --- Transactional email (story email/01) ---
  // Provider: Azure Communication Services (Karan-approved 2026-09-24).
  // The ACS resource + sender domain are NOT provisioned by this story —
  // provisioning, DNS, and credentials are Karan-gated (standing Azure-spend
  // rule). Default 'log' keeps dev/test fully local; the log provider
  // refuses to run in production (fail-closed).
  EMAIL_PROVIDER: z.enum(['log', 'postmark', 'acs']).default('log'),
  // Sender identity placeholder — swapped when the domain is confirmed.
  EMAIL_FROM_ADDRESS: z.string().email().default('noreply@feasly.example'),
  EMAIL_FROM_NAME: z.string().min(1).default('Feasly'),
  // Provider credentials: Key Vault references in staging/production, never
  // committed. Absent credentials fail closed at send time with the exact
  // variable named.
  EMAIL_POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
  EMAIL_POSTMARK_ENDPOINT: z
    .string()
    .url()
    .default('https://api.postmarkapp.com/email'),
  EMAIL_ACS_CONNECTION_STRING: z.string().min(1).optional(),
  // Bound on the whole ACS send operation (beginSend + delivery poll): the
  // send is synchronous in the HTTP request path, so an unbounded send
  // stalls the response (2026-09-27: lead-gate "Sending..." hang on the
  // poll; 2026-09-28: same hang on the beginSend await, which had no bound
  // at all). Past the deadline the send fails LOUD — the lead row and
  // token are already committed, so a retry is safe (dedupe live-link
  // path). 7s default: the email service retries transient failures
  // in-code (EMAIL_SEND_MAX_ATTEMPTS), so the worst case is 7+1+7+1+7 =
  // 23s — inside the frontend gate-submit timeout (25s).
  EMAIL_ACS_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(7_000),
  // In-code email retry budget: initial try + retries, inside the email
  // service's deliver() (Karan 2026-09-27: at least 2 retries, no queue).
  // Only retryable failures (timeouts, 429, 5xx, network errors) are
  // retried — a wrong email address fails immediately.
  EMAIL_SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  // Base URL the web app lives at — magic-link / resume links are built
  // from this. Placeholder until the production domain is confirmed.
  APP_BASE_URL: z.string().url().default('https://feasly.example'),
  // Base URL for the emailed preference-center links (email/03, live since
  // PR #243): templates render `${UNSUBSCRIBE_URL_BASE}/{token}`. Bicep sets
  // this from the live site URL in every environment; the default below is a
  // local-dev fallback only and must never appear in a sent email.
  UNSUBSCRIBE_URL_BASE: z.string().url().default('https://feasly.example/unsubscribe'),
  // --- Unsubscribe center (story email/03) ---
  // HMAC secret for one-click unsubscribe tokens. Key Vault reference in
  // staging/production, never committed. Absent secret fails closed at
  // token issue/verify time with this variable named (same pattern as the
  // ACS provider credentials).
  UNSUBSCRIBE_TOKEN_SECRET: z.string().min(1).optional(),
  // One-click unsubscribe token validity: 30 days (story requirement).
  UNSUBSCRIBE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  // Team inbox for callback confirmations. Defaults to the seeded super_admin
  // until the owner names an ops inbox (set OPS_INBOX_EMAIL to override).
  OPS_INBOX_EMAIL: z.string().email().default(SEED_ADMIN_EMAIL),
  // Ops alert recipient (admin/06). Defaults to the seeded super_admin until
  // the owner names an ops inbox (set OPS_ALERT_EMAIL to override).
  OPS_ALERT_EMAIL: z.string().email().default(SEED_ADMIN_EMAIL),
  // Ops alert dedupe window per alert class: at most one failure email
  // per class inside this window (admin/06).
  OPS_ALERT_DEDUPE_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  // --- Postgres backup freshness check (admin/06 `backup_missed`) ---
  // Daily timer queries ARM with the Function App's managed identity. Off
  // by default; Bicep enables it per environment with the server details.
  BACKUP_CHECK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  BACKUP_CHECK_SUBSCRIPTION_ID: z.string().default(''),
  BACKUP_CHECK_RESOURCE_GROUP: z.string().default('rg-feasly-dev'),
  BACKUP_CHECK_SERVER_NAME: z.string().default('feasly-dev-pg-4fhkep'),
  // Azure endpoint tunables (defaults are the public-cloud values; config
  // holds all URL literals — services/ must not hardcode them).
  BACKUP_CHECK_IMDS_TOKEN_URL: z
    .string()
    .url()
    .default(
      'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com%2F',
    ),
  // Platform-injected managed-identity endpoint/header (App Service /
  // Functions). Present only on Azure; absent locally and in CI. The
  // backup probe prefers these over the IMDS link-local endpoint. The
  // header is a secret — parsed here, never logged.
  IDENTITY_ENDPOINT: z.string().url().optional(),
  IDENTITY_HEADER: z.string().min(1).optional(),
  BACKUP_CHECK_ARM_BASE_URL: z.string().url().default('https://management.azure.com'),
  // Same thresholds as CI's check-postgres-backup.sh.
  BACKUP_CHECK_MIN_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  BACKUP_CHECK_MAX_STALE_HOURS: z.coerce.number().int().positive().default(48),
  // Dev/test behavior: the log provider logs full links so magic-link flows
  // can be exercised without a provider. Never render links in UI.
  EMAIL_LOG_LINKS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly maxTrackedKeys: number;
}

/** #729: Postgres-backed cross-instance limiter (money/mail endpoints). */
export interface SharedRateLimitConfig {
  /** Per-instance cadence for deleting expired counter rows. */
  readonly sweepIntervalMs: number;
}

export interface LeadConfig {
  /** Tight rate limiter for the public lead-gate endpoint. */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Dedup window in days: same email + address → existing lead. */
  readonly dedupWindowDays: number;
  /** "Needs you" feed: days without a status change before a lead is stale. */
  readonly needsYouStaleDays: number;
  /** "Needs you" feed: max builder leads scanned (newest first). */
  readonly needsYouScanLimit: number;
  /**
   * #788: submissions whose client-reported form time is below this many
   * ms are quarantined like the honeypot. 0 disables the check.
   */
  readonly minSubmitMs: number;
  /**
   * #836: a callback's preferred day must fall within this many calendar
   * days after today (America/Edmonton), business days only.
   */
  readonly callbackDateWindowDays: number;
}

/**
 * #788: invisible bot challenge (Cloudflare Turnstile), required only from
 * an IP that tripped a shared money/mail rate limit.
 */
export interface BotChallengeConfig {
  /** True only when both the site key and the secret are set. */
  readonly enabled: boolean;
  /** Public site key — returned to the client in the challenge problem. */
  readonly siteKey: string;
  /** Server-side secret (Key Vault reference). Never logged or serialized. */
  readonly secretKey: string;
  readonly verifyUrl: string;
  readonly verifyTimeoutMs: number;
  /** How long after a limit trip the IP must pass the challenge. */
  readonly windowMs: number;
  /** Per-IP cap on verifier calls (every attempt counts). */
  readonly verifyRateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
}

export interface EstimateConfig {
  /** Per-IP limiter for the public estimates endpoint (frozen: 20/hr/IP). */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Per-tenant limiter aggregating embed traffic (default 600/hr/tenant: the 10x launch target, #737). */
  readonly tenantRateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
}

export interface AnalyticsConfig {
  /** Generous rate limiter for the public analytics-ingest endpoint. */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /**
   * #814: the admin funnel's per-source breakdown returns at most this many
   * (utm_source, utm_campaign) groups, largest first. Attribution values
   * are client-supplied, so the group count must be bounded.
   */
  readonly funnelSourceGroupLimit: number;
}

export interface WebTelemetryConfig {
  /** Tight per-IP limiter for POST /api/v1/telemetry (#830). */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Per-instance cap on traces emitted per minute; excess items are dropped. */
  readonly maxTracesPerMinute: number;
}

export interface AdminSearchConfig {
  /**
   * Primary per-IP limiter for GET /api/v1/admin/search. Keyed on the
   * client IP so unauthenticated callers can't bypass it with random tokens.
   */
  readonly ipRateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Secondary per-session limiter for GET /api/v1/admin/search. */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Max hits returned per kind. */
  readonly maxHitsPerKind: number;
}

/** Audit viewer + finance exports (#728). */
export interface FinanceExportConfig {
  /** Primary per-IP limiter for the invoice CSV exports. */
  readonly ipRateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Secondary per-session limiter for the invoice CSV exports. */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Max invoice rows in one CSV; larger periods are refused (422). */
  readonly maxRows: number;
  /** Longest period an export or finance summary may cover, in days. */
  readonly maxRangeDays: number;
}

export interface WebhookConfig {
  /** Tight rate limiter for the Stripe webhook receiver (100/min per IP). */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
}

export interface DbConfig {
  readonly poolMaxSize: number;
}

export interface AuthConfig {
  /** Lifetime of the JWT session cookie issued after magic-link verification. */
  readonly jwtTtlSeconds: number;
  /** Lifetime of a single-use magic-link token. */
  readonly magicLinkTtlSeconds: number;
  /**
   * HRD-03: minimum ms between magic-link emails to the same address on the
   * reissue path (from MAGIC_LINK_REISSUE_COOLDOWN_MS).
   */
  readonly magicLinkReissueCooldownMs: number;
  /**
   * P1-6 (2026-09-30 security audit): max magic-link emails sent to one
   * address per hour, enforced per-email inside the reissue and
   * builder-auth-request services (from MAGIC_LINK_MAX_SENDS_PER_HOUR).
   * Exhaustion answers with the endpoint's normal non-send shape —
   * never a 429 — so the budget can't become a send oracle.
   */
  readonly magicLinkMaxSendsPerHour: number;
  /**
   * #806: lifetime of the fresh owner link emailed for erase confirmation
   * (from PRIVACY_ERASE_CONFIRM_LINK_TTL_SECONDS, default 24 h).
   */
  readonly eraseConfirmLinkTtlSeconds: number;
  /**
   * INTERIM (api-mcp/01): pre-shared key for the admin endpoints, from
   * ADMIN_API_KEY. admin/01 replaces this with session auth. Undefined =
   * admin endpoints fail closed.
   */
  readonly adminApiKey: string | undefined;
  /** Absolute lifetime of an admin session (#730: 12 h). */
  readonly adminSessionTtlSeconds: number;
  /** Admin idle timeout (#730: 1 h). */
  readonly adminSessionIdleTimeoutSeconds: number;
  /** Absolute lifetime of a builder session (#730: 7 days). */
  readonly builderSessionTtlSeconds: number;
  /** Builder idle timeout (#730: 24 h). */
  readonly builderSessionIdleTimeoutSeconds: number;
  /** Minimum interval between last_seen_at writes for one session (#730). */
  readonly sessionActivityTouchIntervalSeconds: number;
  /** Max age of the sign-in for dangerous actions (#730). */
  readonly sessionReauthWindowSeconds: number;
  /** Lifetime of an invitation (auth/01: 7 days). */
  readonly invitationTtlSeconds: number;
}

/**
 * Microsoft Entra External ID wiring (auth/01). `configured` is false
 * until the tenant exists and all four values are set — the
 * EntraUserService refuses to call Graph before then.
 */
export interface EntraConfig {
  readonly tenantId: string;
  readonly graphClientId: string;
  readonly graphClientSecret: string;
  readonly issuerDomain: string;
  /**
   * Microsoft identity platform + Graph endpoints. Stable global
   * endpoints, not per-tenant tunables — defaults live here (like
   * postmarkEndpoint) rather than in the service.
   */
  readonly loginBaseUrl: string;
  readonly graphBaseUrl: string;
  readonly configured: boolean;
}

export interface EntraRateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
}

/**
 * Microsoft Entra External ID sign-in (auth/02). Separate from auth/01's
 * `EntraConfig` (Graph-side provisioning): this is the runtime sign-in
 * wiring for the callback. `configured` is false while any of the four
 * tenant values is empty — the callback fails closed with 503.
 */
export interface EntraSignInConfig {
  /**
   * Tenant subdomain, e.g. `feaslyext` for `feaslyext.ciamlogin.com`
   * (AUTH-00). Empty until provisioned.
   */
  readonly tenantSubdomain: string;
  /** Entra External ID tenant (directory) id. Empty until provisioned. */
  readonly tenantId: string;
  /** Application (client) id of the `feasly-web` app registration. */
  readonly clientId: string;
  /**
   * Client secret for the `feasly-web` app registration (Key Vault in
   * Azure, plain env locally). Required: the redirect URI is registered on
   * the "Web" platform, so the token endpoint treats the backend as a
   * confidential client. Empty = `configured` is false and the callback
   * 503s fail-closed.
   */
  readonly clientSecret: string;
  /** Sign-in user flow name, e.g. `feasly_signup_signin`. */
  readonly userFlow: string;
  /** False while any of the five values above is empty — the callback 503s. */
  readonly configured: boolean;
  /** Derived: the OAuth2 token endpoint for the authorization-code exchange. */
  readonly tokenEndpoint: string;
  /** Derived: the JWKS discovery URI for id_token signature verification. */
  readonly jwksUri: string;
  /**
   * Derived: the expected `iss` claim of id_tokens from this tenant.
   * Tenant-ID host (not the domain name) per the tenant's
   * openid-configuration.
   */
  readonly issuer: string;
  /**
   * Derived: the OAuth2 end-session endpoint that terminates the Entra
   * IdP session on logout. Without a full-page navigation here, the
   * Entra cookie survives our session revocation and the next "Sign in"
   * silently re-authenticates (Karan, 2026-09-28). The caller appends
   * `?post_logout_redirect_uri={app}/admin/login` — that URL must be
   * registered as a logout URL on the app registration (portal step).
   */
  readonly logoutEndpoint: string;
  /** JWKS cache TTL in milliseconds. */
  readonly jwksCacheTtlMs: number;
  /** HTTP timeout (ms) for the Entra token/JWKS calls. */
  readonly httpTimeoutMs: number;
  /** Tight per-IP rate limiter for the public callback (10/15min frozen). */
  readonly callbackRateLimit: EntraRateLimitConfig;
}

export interface QueueConfig {
  readonly email: string;
  readonly pdf: string;
  readonly sheets: string;
}

export interface EmailConfig {
  /** 'log' = dev/test console transport (refuses production). */
  readonly provider: 'log' | 'postmark' | 'acs';
  readonly fromAddress: string;
  readonly fromName: string;
  /** Key Vault reference in staging/production; absent = fail-closed sends. */
  readonly postmarkServerToken?: string;
  readonly postmarkEndpoint: string;
  readonly acsConnectionString?: string;
  /**
   * Deadline for the whole ACS send operation (beginSend + delivery poll),
   * in milliseconds. The send runs inline in the HTTP request path, so
   * this bounds how long a stalled send can hold the response open before
   * it fails loud. Default 7s: with in-code retries the worst case is
   * 7+1+7+1+7 = 23s, inside the frontend gate-submit timeout (25s).
   */
  readonly acsSendTimeoutMs: number;
  /**
   * Max email send attempts (initial try + retries), from
   * EMAIL_SEND_MAX_ATTEMPTS. Only retryable failures are retried.
   */
  readonly sendMaxAttempts: number;
  /** Web-app base URL that magic-link / resume links are built from. */
  readonly appBaseUrl: string;
  /** One-click unsubscribe links are built from this (email/03). */
  readonly unsubscribeUrlBase: string;
  /**
   * HMAC secret for unsubscribe tokens. Key Vault reference in
   * staging/production; absent = fail-closed token issue/verify.
   */
  readonly unsubscribeTokenSecret?: string;
  /** One-click unsubscribe token validity in seconds (30 days). */
  readonly unsubscribeTokenTtlSeconds: number;
  /** Team inbox for callback confirmations (standing test email for now). */
  readonly opsInbox: string;
  /** Ops alert recipient (admin/06; standing test email for now). */
  readonly opsAlertEmail: string;
  /** Ops alert dedupe window per alert class, in milliseconds. */
  readonly opsAlertDedupeWindowMs: number;
  /** Log provider logs full links when true (dev/test behavior). */
  readonly logLinks: boolean;
}

export interface HealthConfig {
  /** A dependency ping slower than this marks the check failed, not hung. */
  readonly dbTimeoutMs: number;
}

export interface CostEngineConfig {
  /**
   * Whether renovation estimates may run on uncalibrated draft rate tables
   * (RENO-01). False by default; production refuses draft data entirely.
   */
  readonly allowDraftCostData: boolean;
}

export interface PropertyDataConfig {
  /** Socrata API base (e.g. https://data.calgary.ca) — no key required. */
  readonly socrataBaseUrl: string;
  /** Property Assessment dataset ID. */
  readonly datasetId: string;
  /** In-memory cache TTL for Socrata responses. */
  readonly cacheTtlMs: number;
  /** HTTP timeout for Socrata requests. */
  readonly httpTimeoutMs: number;
  /** Max rows fetched per Socrata query. */
  readonly searchRowLimit: number;
  /** Max autocomplete suggestions returned. */
  readonly suggestionLimit: number;
  /**
   * #755: home age (years) at/over which a property is a redevelopment
   * candidate; younger homes are steered to renovation. Market config.
   */
  readonly redevelopmentMinAgeYears: number;
  /** Durable (Postgres) cache TTL for assessment-roll records (#756). */
  readonly dbCacheTtlMs: number;
  /** Max wait on a durable-cache read/write before falling through (#756). */
  readonly dbCacheTimeoutMs: number;
  /** `Cache-Control: max-age` (seconds) on property GETs (#756). */
  readonly httpCacheMaxAgeSeconds: number;
}

/** Which current land-use district source a city uses (#686). */
export type LandUseProviderKind = 'calgary-land-use-districts' | 'assessment-roll';

/**
 * Current land-use district lookup (#686). Shares SOCRATA_BASE_URL with
 * propertyData; its own dataset, cache TTL and (short) timeout so a slow
 * district lookup can never add more than `httpTimeoutMs` to a lookup.
 */
export interface LandUseConfig {
  /** Provider for this city; 'assessment-roll' skips the lookup entirely. */
  readonly provider: LandUseProviderKind;
  /** Socrata API base (e.g. https://data.calgary.ca) — no key required. */
  readonly socrataBaseUrl: string;
  /** Land Use Districts dataset ID. */
  readonly datasetId: string;
  /** How long a resolved district is reused before re-checking. */
  readonly cacheTtlMs: number;
  /** Durable (Postgres) cache TTL for a resolved district (#756). */
  readonly dbCacheTtlMs: number;
  /** HTTP timeout for the district request (falls back to the roll value). */
  readonly httpTimeoutMs: number;
}

/**
 * Zoning rules catalogue config (#687). The catalogue itself is data in
 * `@feasly/zoning`; config only picks the city and the HTTP cache lifetime.
 */
export interface ZoningConfig {
  /** City key of the served catalogue, e.g. 'calgary'. */
  readonly city: string;
  /** Cache-Control max-age (seconds) on the public catalogue response. */
  readonly cacheMaxAgeSeconds: number;
  /** In-memory TTL (ms) for the watch state read by the catalogue route. */
  readonly freshnessCacheTtlMs: number;
  /** #757: daily City-source watcher. */
  readonly watch: ZoningWatchConfig;
}

/** Zoning source watch config (#757). */
export interface ZoningWatchConfig {
  readonly enabled: boolean;
  /** Socrata host of the Land Use Districts dataset. */
  readonly socrataBaseUrl: string;
  /** Land Use Districts dataset id (same as landUse.datasetId). */
  readonly landUseDatasetId: string;
  /** The City's Land Use Bylaw page, watched for amendments. */
  readonly bylawPageUrl: string;
  readonly httpTimeoutMs: number;
  /** `owner/repo` the out-of-date issue is filed in. */
  readonly githubRepo: string;
  /** GitHub token (Key Vault reference); '' = file no issue. */
  readonly githubToken: string;
  /** GitHub REST base URL. */
  readonly githubApiUrl: string;
}

/**
 * Builder partner disclosure config (#888). The partner list itself is
 * data (`builder_partners`); config only sets the cache lifetimes.
 */
export interface PartnersConfig {
  /** In-memory TTL (ms) for the public active-partner list; 0 = no cache. */
  readonly cacheTtlMs: number;
  /** Cache-Control max-age (seconds) on the public partner response. */
  readonly cacheMaxAgeSeconds: number;
}

/**
 * City-data freshness config (trust-strip/01).
 *
 * The landing trust strip reads "Refreshed <Month Year>" from the
 * Property Assessment dataset's Socrata metadata (`rowsUpdatedAt`).
 * Reuses the SOCRATA_* env vars (same source as propertyData) plus a
 * dedicated 24h cache TTL — the metadata changes at most monthly, so a
 * failed fetch simply answers `{ refreshedMonth: null }` and the next
 * request retries.
 */
export interface CityDataFreshnessConfig {
  /** Socrata API base (e.g. https://data.calgary.ca) — no key required. */
  readonly socrataBaseUrl: string;
  /** Property Assessment dataset ID. */
  readonly datasetId: string;
  /** HTTP timeout for the Socrata metadata request. */
  readonly httpTimeoutMs: number;
  /** In-memory cache TTL for SUCCESSFUL metadata fetches (24h default). */
  readonly cacheTtlMs: number;
}

/** Agent API access policy (#738, owner decision 2026-11-15). */
export interface ApiAccessConfig {
  /** Accepted calls per key per UTC calendar day. */
  readonly dailyQuota: number;
  /** Accepted calls per key per UTC calendar month. */
  readonly monthlyQuota: number;
  /** The consent-attestation version an API lead must carry. */
  readonly leadConsentVersion: string;
  /** API-key leads go to the admin quarantine queue for review. */
  readonly quarantineLeads: boolean;
}

/** Waitlist signups (#520, #740). */
export interface WaitlistConfig {
  /** Consent-wording version stored with every signup (`consent_version`). */
  readonly consentVersion: string;
}

/**
 * Embed platform config (embed/02, embed/06).
 */
export interface EmbedConfig {
  /**
   * Relay-code lifetime in seconds (embed/06). The single-use token in the
   * magic-link email URL (`?feasly_rt=`). Story pins 10 minutes.
   */
  readonly relayCodeTtlSeconds: number;
  /**
   * Session-token lifetime in seconds (embed/06). What the iframe holds in
   * memory after exchanging the relay code. Story pins 12 hours.
   */
  readonly sessionTtlSeconds: number;
  /**
   * Minimum seconds between relay-code resends for the same code
   * (embed/06 AC3). Story pins 60 seconds.
   */
  readonly relayResendCooldownSeconds: number;
}

export interface BillingConfig {
  /**
   * Active billing model. 'commission' = % of signed construction contract
   * value (excl. land); 'flat' = monthly subscription per builder tenant.
   * Karan 2026-09-24: commission at 1%, switchable via config only.
   */
  readonly model: 'commission' | 'flat';
  /** Commission rate as a fraction (0.01 = 1%). Used when model='commission'. */
  readonly commissionRate: number;
  /**
   * Attribution window in days: a contract signed within this long after
   * the lead→builder introduction attributes to Feasly (12 months).
   */
  readonly attributionWindowDays: number;
  /** Builder reporting SLA in days from contract signature (14 days). */
  readonly reportingSlaDays: number;
  /** Max off-session charge retries per failed commission invoice (3). */
  readonly maxChargeRetries?: number;
  /**
   * Hours an invoice may sit 'finalized' (charge in progress) before the
   * daily reconciliation reads the PaymentIntent from Stripe and the admin
   * webhooks page flags it (#711). Default 24.
   */
  readonly settlementThresholdHours?: number;
  /**
   * #718: default per-invoice dunning grace period in days (7). Card
   * invoices retry this long after a failed charge; manual-method invoices
   * are overdue this long after the review window closes. Admin can
   * override it per invoice.
   */
  readonly dunningGraceDays?: number;
  /**
   * Sales tax on commission invoices (#714). Absent or `enabled: false` =
   * no tax: every invoice figure and document matches the pre-tax output.
   */
  readonly tax?: BillingTaxConfig;
  /**
   * #716: bank-statement text for commission charges (Stripe
   * `statement_descriptor_suffix`). Undefined = Stripe account default.
   */
  readonly statementDescriptor?: string;
  /**
   * #716: a saved card whose expiry month ends within this many days is
   * flagged `expiresSoon` on GET /billing/card. Default 30.
   */
  readonly cardExpiryWarningDays?: number;
  /** Flat-plan fields — dormant until model='flat'. */
  readonly flatPlanName: string;
  /** Flat monthly price in integer minor units (cents). */
  readonly flatMonthlyCents: number;
  /** ISO 4217 currency code for the flat plan. */
  readonly flatCurrency: string;
  /**
   * Stripe secret key (`sk_test_…` outside production, `sk_live_…` in
   * production — enforced at startup). Absent = billing dormant.
   */
  readonly stripeSecretKey: string | undefined;
  /** Stripe webhook signing secret (`whsec_…`). Absent = webhooks disabled. */
  readonly stripeWebhookSecret: string | undefined;
  /** Stripe Price id for the flat plan — only read when model='flat'. */
  readonly stripeFlatPriceId: string | undefined;
  /** True when NODE_ENV=production (live-money guard). */
  readonly isProduction: boolean;
}

/** #753: payment provider selection (simulated until Stripe exists). */
export interface PaymentsConfig {
  readonly provider: 'simulated' | 'stripe';
  /** Simulated provider only; undefined → random per-process secret. */
  readonly simulatedWebhookSecret: string | undefined;
  /** Simulated provider only: webhook delivery delay after a charge. */
  readonly simulatedWebhookDelayMs: number;
}

/** Sales tax (GST/HST) applied to commission invoices (#714). */
export interface BillingTaxConfig {
  /** When false, new invoices carry no tax (rate 0). */
  readonly enabled: boolean;
  /** Tax rate in PERCENT (5 = 5% GST), snapshotted onto each invoice. */
  readonly ratePercent: number;
  /** Label printed next to the tax line, e.g. "GST". */
  readonly label: string;
  /** false = commission plus tax (default); true = commission includes tax. */
  readonly inclusive: boolean;
  /** Supplier legal name printed on tax invoices. */
  readonly supplierLegalName: string;
  /** Supplier address printed on tax invoices. */
  readonly supplierAddress: string;
  /** GST/HST registration number printed on tax invoices. */
  readonly registrationNumber: string;
}

/** #703: post-report follow-up email (hourly timer, flag default off). */
/** #725: builder new-lead email + daily "Needs you" digest. */
/** #870: builder portal Settings (support contact + embed install check). */
export interface BuilderSettingsConfig {
  /** Support address shown to builders (BUILDER_SUPPORT_EMAIL, else the team inbox). */
  readonly supportEmail: string;
  /** Promised response time copy, e.g. "within 1 business day". */
  readonly supportResponseTime: string;
  /** An origin is "live" when the widget loaded there within this many days. */
  readonly embedLiveWindowDays: number;
  /** Absolute URL of the embed loader script for the install snippet. */
  readonly embedLoaderUrl: string;
}

export interface BuilderNotificationsConfig {
  /** Kill switch — false = no enqueue, no sends (default true). */
  readonly enabled: boolean;
  /** Delivery attempts per notification (initial + timer retries). */
  readonly maxAttempts: number;
  /** Pending rows older than this are no longer retried. */
  readonly retryWindowHours: number;
  /** A claimed row is not re-claimed for this long (no double send). */
  readonly claimLeaseMinutes: number;
  /** Local hour (0–23) the daily digest becomes due. */
  readonly digestLocalHour: number;
  /** IANA zone for the digest hour and the digest's day key. */
  readonly digestTimeZone: string;
}

export interface FollowUpEmailConfig {
  readonly enabled: boolean;
  /** Hours after the report is first opened before the follow-up is due. */
  readonly delayHours: number;
}

/** #838: Postgres-backed job queue tunables. */
export interface JobQueueConfig {
  /** Max jobs claimed per worker run. */
  readonly batchSize: number;
  /** Attempts before a job is dead-lettered. */
  readonly maxAttempts: number;
  /** First retry delay, seconds (doubles per attempt). */
  readonly backoffBaseSeconds: number;
  /** Retry delay ceiling, seconds. */
  readonly backoffMaxSeconds: number;
  /** A running job older than this is reclaimed (worker crash). */
  readonly lockTimeoutSeconds: number;
}

/** #838: homeowner reminder caps. */
export interface RemindersConfig {
  /** Hours after lead capture before the "unfinished estimate" reminder. */
  readonly unfinishedDelayHours: number;
  /** Max reminders enqueued per scheduler run, per reminder type. */
  readonly maxPerRun: number;
}

/** #838: link-only report shares. */
export interface ShareLinkConfig {
  /** Link lifetime, seconds. */
  readonly ttlSeconds: number;
  /** Max live links per report. */
  readonly maxActive: number;
}

/** #765: API-key auth posture (revocation lag + live/sandbox isolation). */
export interface ApiKeyAuthConfig {
  /** Per-instance auth cache TTL, seconds (0–60; 0 = no cache). */
  readonly authCacheTtlSeconds: number;
  /** Which keys this deployment accepts. */
  readonly acceptedModes: 'all' | 'live' | 'sandbox';
}

export interface SandboxPurgeConfig {
  readonly retentionDays: number;
  readonly dryRun: boolean;
}

/**
 * Community-stats monthly refresh (neighbourhood/05). Recomputes
 * `community_stats` from fresh City of Calgary Socrata aggregates; the API
 * stays cache-first and never calls Socrata per-request.
 */
export interface CommunityStatsRefreshConfig {
  /**
   * Minimum fresh assessment records for a community to be (re)written.
   * Below this the community is skipped with a warning log — never written
   * as zero (a thin-data community must not masquerade as a cheap one).
   */
  readonly minAssessmentCount: number;
  /** Consecutive timer failures before the ops alert fires. */
  readonly alertAfterConsecutiveFailures: number;
  /**
   * Safety floor for pruning: rows the current refresh did not produce are
   * deleted only when the cycle wrote at least this many rows, so a partial
   * Socrata response can never wipe the table (#468).
   */
  readonly pruneMinRows: number;
}

/** #773: neighbourhood provider implementation names (config-selected). */
export type SchoolDirectoryImpl = 'free-public' | 'calgary-open-data' | 'none';
export type SchoolDesignationImpl = 'none';
export type SchoolRatingsImpl = 'none';
export type ReviewsImpl = 'none';
export type AmenitiesImpl = 'calgary-open-data' | 'none';
export type CommuteImpl = 'straight-line' | 'none';

/**
 * #777: one amenity category the free `calgary-open-data` AmenitiesProvider
 * loads from a City open-data dataset (point, polygon or line geometry —
 * polygons/lines become one representative point).
 */
export interface AmenityCategoryConfig {
  /** Stable kebab key, e.g. 'parks' — the stored `category`. */
  readonly key: string;
  /** Display label, e.g. 'Parks'. */
  readonly label: string;
  readonly datasetId: string;
  /** Optional SoQL `$where` filter. */
  readonly where?: string;
  /** Source field holding a stable id (else derived from name + location). */
  readonly idField?: string;
  /** Source field holding the name (else the label). */
  readonly nameField?: string;
}

/**
 * Neighbourhood data (#773). Outside sources sit behind provider interfaces
 * chosen here; a monthly refresh writes them to our tables and request
 * paths only ever read those tables.
 */
export interface NeighbourhoodDataConfig {
  readonly providers: {
    readonly schoolDirectory: SchoolDirectoryImpl;
    readonly schoolDesignation: SchoolDesignationImpl;
    readonly schoolRatings: SchoolRatingsImpl;
    readonly reviews: ReviewsImpl;
    readonly amenities: AmenitiesImpl;
    readonly commute: CommuteImpl;
  };
  /** City open-data endpoint (shared with property data). */
  readonly socrataBaseUrl: string;
  readonly schoolsDatasetId: string;
  /** #777: amenity categories the free AmenitiesProvider loads. */
  readonly amenityCategories: readonly AmenityCategoryConfig[];
  /** #777: public-tree cover per community. */
  readonly publicTreesDatasetId: string;
  /** City community boundaries: tree-cover area (#777), school → community code (#774). */
  readonly communityBoundariesDatasetId: string;
  /** Public trees per hectare: [low, high]. */
  readonly treeCoverThresholds: readonly [number, number];
  readonly amenitySearchRadiusM: number;
  readonly amenityCountRadiiM: readonly number[];
  readonly communityMetricsTtlMs: number;
  readonly communityPointsDatasetId: string;
  /** #774: OpenStreetMap Overpass endpoint + Calgary bbox (S,W,N,E). */
  readonly osmOverpassUrl: string;
  readonly osmBbox: string;
  readonly osmHttpTimeoutMs: number;
  /** #774: same-school match radius across sources (metres). */
  readonly schoolDedupeRadiusM: number;
  /** #690: residential class + established community structures. */
  readonly communityClass: string;
  readonly communityStructures: readonly string[];
  readonly commuteDestination: {
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
  };
  readonly httpTimeoutMs: number;
  readonly maxRows: number;
  /** Day of the month (UTC) each provider becomes due. */
  readonly refreshDayOfMonth: number;
  /** Days of continuous failure before the one ops alert. */
  readonly alertAfterFailureDays: number;
  readonly lotRadiusM: number;
  readonly lotMetricsTtlMs: number;
}

/**
 * Community lot inventory (#691): which communities and parcels the weekly
 * refresh lists, how politely it pages Socrata, and how the public list is
 * served. Dataset ids for assessments / land use come from propertyData /
 * landUse.
 */
export interface CommunityLotsConfig {
  /** City key stored on every row and served in the response. */
  readonly city: string;
  /** Socrata API base (shared SOCRATA_BASE_URL). */
  readonly socrataBaseUrl: string;
  /** Assessment dataset (shared SOCRATA_DATASET_ID). */
  readonly assessmentDatasetId: string;
  /** Community District Boundaries dataset (established-area flag). */
  readonly boundariesDatasetId: string;
  /** Boundary `class` values that count as established infill. */
  readonly establishedClasses: readonly string[];
  /** Boundary `comm_structure` values that count as established infill. */
  readonly establishedStructures: readonly string[];
  /** Sliver guard: lots below this area are excluded (0 = off). */
  readonly minLotSqft: number;
  /** Qualifying current-district prefixes (case-insensitive). */
  readonly allowedDistrictPrefixes: readonly string[];
  readonly pageSize: number;
  readonly requestDelayMs: number;
  readonly districtConcurrency: number;
  readonly httpTimeoutMs: number;
  readonly maxAttempts: number;
  readonly staleAfterDays: number;
  readonly alertAfterConsecutiveFailures: number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly cacheMaxAgeSeconds: number;
}

/**
 * Postgres backup freshness check (admin/06 `backup_missed`). The daily
 * timer queries ARM with the Function App's managed identity; a stale or
 * missing backup chain fires the alert, recovery sends the all-clear.
 * Disabled unless BACKUP_CHECK_ENABLED=true and the server details are set.
 */
export interface BackupCheckConfig {
  readonly enabled: boolean;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly serverName: string;
  /** Minimum backup retention days (same threshold as CI's backup-config job). */
  readonly minRetentionDays: number;
  /** Max age of the earliest restore point in hours before "stale". */
  readonly maxStaleHours: number;
  /** IMDS token endpoint (config holds the URL literal, not the service). */
  readonly imdsTokenUrl: string;
  /**
   * Platform-injected managed-identity endpoint (`IDENTITY_ENDPOINT`).
   * Preferred over IMDS on Azure Functions / App Service.
   */
  readonly identityEndpoint?: string;
  /**
   * Platform-injected managed-identity header (`IDENTITY_HEADER`). Secret —
   * sent as the `X-IDENTITY-HEADER` header, never logged.
   */
  readonly identityHeader?: string;
  /** ARM base URL (config holds the URL literal, not the service). */
  readonly armBaseUrl: string;
}

/**
 * Google Sheets sync (admin/04). Empty sheetId/serviceAccountEmail = sync
 * disabled; the worker fails closed (no sync, alert fires).
 */
export interface SheetsConfig {
  /** Destination Sheet ID (placeholder until Karan shares his Sheet). */
  readonly sheetId: string;
  /** Service-account email (placeholder until provisioned). */
  readonly serviceAccountEmail: string;
  /** Service-account private key (from Key Vault, never in repo). */
  readonly serviceAccountPrivateKey: string;
  /** Max leads per hourly sync run (backpressure). */
  readonly maxLeadsPerRun: number;
  /** Google Sheets API OAuth scope. */
  readonly apiScope: string;
  /** True when both sheetId and serviceAccountEmail are configured. */
  readonly enabled: boolean;
  /** Hours without a successful sync before the ops panel calls it lagging. */
  readonly lagAfterHours: number;
  /** Minutes after which a stuck 'running' run is considered stale. */
  readonly runStaleAfterMin: number;
}

export interface NarrativeConfig {
  /** 'log' = dev/test console transport; 'openai-compatible' = remote OpenAI-protocol LLM. */
  readonly provider: 'log' | 'openai-compatible';
  /** LLM API key (from Key Vault, never in repo). Empty = fail-closed. */
  readonly apiKey: string;
  /**
   * Ordered narrative model list, primary first (parsed from
   * NARRATIVE_MODELS). The provider tries the next model on capacity
   * errors (408/429/5xx), timeouts, and network failures. Always
   * non-empty — loadConfig throws on an empty list.
   */
  readonly models: readonly string[];
  /** Per-attempt timeout (ms) for each model in the narrative chain. */
  readonly timeoutMs: number;
  /** Base URL of the OpenAI-compatible endpoint (chat/completions appended if missing). */
  readonly endpoint: string;
  /**
   * Fallback provider step (Groq, OpenAI-compatible). Tried after the
   * primary chain on capacity errors (408/429/5xx), timeouts, and
   * network failures; skipped gracefully when apiKey is empty. The
   * static guide remains the final resilience tier.
   */
  readonly fallback: {
    /** Base URL of the fallback OpenAI-compatible endpoint. */
    readonly endpoint: string;
    /** Fallback API key (Key Vault, never in repo). Empty = step skipped. */
    readonly apiKey: string;
    /** Ordered fallback model list, primary first. Always non-empty. */
    readonly models: readonly string[];
  };
}

/**
 * Parse the comma-separated NARRATIVE_MODELS value into an ordered,
 * trimmed, non-empty list. Throws on empty so a misconfigured
 * deployment fails closed at startup, not at first narrative request.
 */
export function parseNarrativeModels(raw: string): readonly string[] {
  const models = raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (models.length === 0) {
    throw new Error(
      'NARRATIVE_MODELS is empty — configure at least one narrative model (comma-separated).',
    );
  }
  return models;
}

/** Monthly community narratives (#759). */
export interface CommunityNarrativesConfig {
  /** Timer + admin regenerate on/off (reads always work). */
  readonly enabled: boolean;
  /** NCRONTAB tick — mirrors community-narrative-timer/function.json. */
  readonly schedule: string;
  /** 'last' or a day of the month 1-28. */
  readonly runDay: 'last' | number;
  /** Daily retry ticks after the run day before one ops alert. */
  readonly retryDays: number;
  /** Ordered model list (COMMUNITY_NARRATIVE_MODELS, else NARRATIVE_MODELS). */
  readonly models: readonly string[];
  /** Stamped on every stored narrative. */
  readonly promptVersion: string;
  /** Cost guard: max generations per tick / admin request. */
  readonly maxPerRun: number;
  /** Wall-clock budget for an admin "regenerate all" request. */
  readonly adminBudgetMs: number;
  /** Wall-clock budget for one timer tick (below the host timeout). */
  readonly tickBudgetMs: number;
}

export interface ApiConfig {
  readonly serviceName: string;
  /** Mirrors apps/api/package.json — the single source of truth. */
  readonly version: string;
  readonly env: NodeEnv;
  readonly databaseUrl: string;
  readonly db: DbConfig;
  readonly rateLimit: RateLimitConfig;
  readonly sharedRateLimit: SharedRateLimitConfig;
  readonly lead: LeadConfig;
  readonly botChallenge: BotChallengeConfig;
  readonly estimate: EstimateConfig;
  readonly analytics: AnalyticsConfig;
  readonly webTelemetry: WebTelemetryConfig;
  readonly adminSearch: AdminSearchConfig;
  readonly financeExport: FinanceExportConfig;
  readonly webhook: WebhookConfig;
  readonly auth: AuthConfig;
  readonly entra: EntraConfig;
  /** Microsoft Entra External ID sign-in (auth/02). Fail-closed while unprovisioned. */
  readonly entraSignIn: EntraSignInConfig;
  /**
   * Builder-portal Entra External ID sign-in (auth/05). Separate app
   * registration / user flow from the admin one. Fail-closed while
   * unprovisioned (placeholder — Karan provisions via portal).
   */
  readonly builderEntraSignIn: EntraSignInConfig;
  readonly corsOrigins: readonly string[];
  /** Public site URL — production `servers` entry in the OpenAPI spec. */
  readonly siteUrl: string;
  readonly queues: QueueConfig;
  readonly email: EmailConfig;
  readonly health: HealthConfig;
  readonly costEngine: CostEngineConfig;
  readonly propertyData: PropertyDataConfig;
  readonly landUse: LandUseConfig;
  readonly zoning: ZoningConfig;
  readonly partners: PartnersConfig;
  readonly cityDataFreshness: CityDataFreshnessConfig;
  readonly billing: BillingConfig;
  /** #753: which payment provider billing talks to. */
  readonly payments: PaymentsConfig;
  readonly sandboxPurge: SandboxPurgeConfig;
  readonly apiKeyAuth: ApiKeyAuthConfig;
  readonly followUpEmail: FollowUpEmailConfig;
  readonly jobQueue: JobQueueConfig;
  readonly reminders: RemindersConfig;
  readonly shareLink: ShareLinkConfig;
  readonly builderNotifications: BuilderNotificationsConfig;
  readonly builderSettings: BuilderSettingsConfig;
  readonly sheets: SheetsConfig;
  readonly narrative: NarrativeConfig;
  readonly communityNarratives: CommunityNarrativesConfig;
  readonly communityStatsRefresh: CommunityStatsRefreshConfig;
  readonly communityLots: CommunityLotsConfig;
  readonly neighbourhoodData: NeighbourhoodDataConfig;
  readonly backupCheck: BackupCheckConfig;
  readonly embed: EmbedConfig;
  readonly waitlist: WaitlistConfig;
  readonly apiAccess: ApiAccessConfig;
}

/** Turn a ZodError into a readable startup failure naming each variable. */
function formatConfigError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${name}: ${issue.message}`;
  });
  return `Invalid configuration:\n${lines.join('\n')}`;
}

/**
 * Test-mode enforcement (billing/02, Karan's "no real charges in dev/staging"
 * rule). When a Stripe secret key is configured:
 * - non-production envs REQUIRE an `sk_test_…` key;
 * - production REQUIRES an `sk_live_…` key.
 * Fails fast at startup with the variable named. Absent key = billing
 * dormant (no throw).
 */
function enforceStripeTestMode(
  secretKey: string | undefined,
  nodeEnv: NodeEnv,
): string | undefined {
  if (secretKey === undefined) return undefined;
  const isLiveKey = secretKey.startsWith('sk_live_');
  const isTestKey = secretKey.startsWith('sk_test_');
  if (nodeEnv === 'production' && !isLiveKey) {
    throw new Error(
      'Invalid configuration:\n  - STRIPE_SECRET_KEY: production requires an sk_live_ key',
    );
  }
  if (nodeEnv !== 'production' && !isTestKey) {
    // Don't crash the entire API for a bad Stripe key in dev/staging —
    // warn and treat Stripe as unconfigured. Stripe operations will fail
    // with "not configured" errors, but the API stays up.
    // (2026-09-28: the throw here took down all functions when dev had a
    // placeholder key; fail-open for availability, fail-closed for charges.)
    console.warn(
      `[config] STRIPE_SECRET_KEY is not an sk_test_ key in ${nodeEnv}; ` +
        'treating Stripe as unconfigured (no real charges possible).',
    );
    return undefined;
  }
  return secretKey;
}

/**
 * #753: resolve the payment provider. Fail closed: unset → `stripe`
 * everywhere. `simulated` must be set explicitly (Bicep sets it for dev
 * only). Deployed apps don't set NODE_ENV at runtime, so the refusal also
 * keys on a live Stripe key — a signal that is present in production.
 */
function resolvePaymentsProvider(
  requested: 'simulated' | 'stripe' | undefined,
  nodeEnv: NodeEnv,
  stripeSecretKey: string | undefined,
): 'simulated' | 'stripe' {
  const provider = requested ?? 'stripe';
  if (provider === 'simulated' && nodeEnv === 'production') {
    throw new Error(
      'Invalid configuration:\n  - PAYMENTS_PROVIDER: production cannot use the simulated payment provider',
    );
  }
  if (provider === 'simulated' && stripeSecretKey?.startsWith('sk_live_')) {
    throw new Error(
      'Invalid configuration:\n  - PAYMENTS_PROVIDER: the simulated payment provider cannot run with a live (sk_live_) STRIPE_SECRET_KEY',
    );
  }
  return provider;
}

/**
 * #714: a tax invoice without the real supplier details is not a valid tax
 * invoice. Production with tax ON must have every supplier detail set —
 * fail fast at startup, naming the variables. Outside production the
 * placeholders are allowed so the tax path can be exercised in dev.
 */
function buildTaxConfig(e: {
  BILLING_TAX_ENABLED: boolean;
  BILLING_TAX_RATE: number;
  BILLING_TAX_LABEL: string;
  BILLING_TAX_INCLUSIVE: boolean;
  BILLING_SUPPLIER_LEGAL_NAME: string;
  BILLING_SUPPLIER_ADDRESS: string;
  BILLING_TAX_REGISTRATION_NUMBER: string;
  NODE_ENV: NodeEnv;
}): BillingTaxConfig {
  if (e.BILLING_TAX_ENABLED && e.NODE_ENV === 'production') {
    const unset = (
      [
        'BILLING_SUPPLIER_LEGAL_NAME',
        'BILLING_SUPPLIER_ADDRESS',
        'BILLING_TAX_REGISTRATION_NUMBER',
      ] as const
    ).filter((key) => e[key].startsWith('PLACEHOLDER'));
    if (unset.length > 0) {
      throw new Error(
        'Invalid configuration:\n' +
          unset
            .map((key) => `  - ${key}: required when BILLING_TAX_ENABLED=true in production`)
            .join('\n'),
      );
    }
  }
  return {
    enabled: e.BILLING_TAX_ENABLED,
    ratePercent: Math.round(e.BILLING_TAX_RATE * 100 * 10_000) / 10_000,
    label: e.BILLING_TAX_LABEL,
    inclusive: e.BILLING_TAX_INCLUSIVE,
    supplierLegalName: e.BILLING_SUPPLIER_LEGAL_NAME,
    supplierAddress: e.BILLING_SUPPLIER_ADDRESS,
    registrationNumber: e.BILLING_TAX_REGISTRATION_NUMBER,
  };
}

type ParsedEnv = z.infer<typeof EnvSchema>;

/**
 * Prefer an explicit DATABASE_URL; otherwise compose one from the POSTGRES_*
 * pieces the Azure Function App provides (password via Key Vault reference —
 * URL-encoded here so special characters can't break parsing). Azure Postgres
 * requires TLS, hence sslmode=require on the composed form.
 */
/**
 * Localhost origins the dev server (`ng serve`, port 4200) runs on. These are
 * added to the CORS allowlist ONLY when NODE_ENV=development (HRD-01) — never
 * in staging/production, and never in test (tests set CORS_ORIGINS explicitly).
 */
const DEV_LOCALHOST_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

/**
 * Effective CORS allowlist: the explicit CORS_ORIGINS CSV, plus localhost
 * defaults when developing locally. Env-gated here — the middleware only
 * ever receives the resolved list, so a production deploy can never inherit
 * dev origins by accident.
 */
function resolveCorsOrigins(e: ParsedEnv): readonly string[] {
  if (e.NODE_ENV !== 'development') return e.CORS_ORIGINS;
  const merged = [...e.CORS_ORIGINS];
  for (const origin of DEV_LOCALHOST_ORIGINS) {
    if (!merged.some((o) => o.toLowerCase() === origin.toLowerCase())) merged.push(origin);
  }
  return merged;
}

/**
 * Prefer an explicit DATABASE_URL; otherwise compose one from the POSTGRES_*
 * pieces the Azure Function App provides (password via Key Vault reference —
 * URL-encoded here so special characters can't break parsing). Azure Postgres
 * requires TLS, hence sslmode=require on the composed form.
 */
function resolveDatabaseUrl(e: ParsedEnv): string {
  if (e.DATABASE_URL && e.DATABASE_URL.length > 0) {
    return e.DATABASE_URL;
  }
  const missing = ['POSTGRES_HOST', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'].filter(
    (name) => !e[name as keyof ParsedEnv],
  );
  if (missing.length > 0) {
    throw new Error(
      `Invalid configuration:\n  - DATABASE_URL: Required: set DATABASE_URL, or all of POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD (missing: ${missing.join(', ')})`,
    );
  }
  const password = encodeURIComponent(e.POSTGRES_PASSWORD as string);
  return `postgresql://${e.POSTGRES_USER}:${password}@${e.POSTGRES_HOST}:5432/${e.POSTGRES_DB}?sslmode=require`;
}

/**
 * Derive the Entra External ID sign-in endpoints from the tenant values
 * (auth/02). This is the ONLY place the ciamlogin.com URL shape is
 * constructed — routes/services/middleware must never embed URL literals
 * (boundary test). Empty tenant values = unprovisioned; callers fail closed
 * via `configured: false`.
 *
 * Endpoint shapes were verified live against the tenant's
 * openid-configuration (2026-09-28): the token endpoint and JWKS URI use
 * the domain-name host, but the id_token `iss` claim uses the TENANT ID as
 * host (`https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0`) — do not
 * rewrite the issuer to the discovery host. The tenant's `jwks_uri` carries
 * no policy param, so none is appended here.
 */
function resolveEntraSignInConfig(e: ParsedEnv): EntraSignInConfig {
  const tenantSubdomain = e.ENTRA_TENANT_SUBDOMAIN;
  const tenantId = e.ENTRA_TENANT_ID;
  const clientId = e.ENTRA_CLIENT_ID;
  const userFlow = e.ENTRA_USER_FLOW;
  const clientSecret = e.ENTRA_CLIENT_SECRET;
  const configured =
    tenantSubdomain.length > 0 &&
    tenantId.length > 0 &&
    clientId.length > 0 &&
    userFlow.length > 0 &&
    clientSecret.length > 0;
  const base = `https://${tenantSubdomain}.ciamlogin.com/${tenantId}`;
  return {
    tenantSubdomain,
    tenantId,
    clientId,
    clientSecret,
    userFlow,
    configured,
    tokenEndpoint: `${base}/oauth2/v2.0/token`,
    jwksUri: `${base}/discovery/v2.0/keys`,
    issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
    logoutEndpoint: `${base}/oauth2/v2.0/logout`,
    jwksCacheTtlMs: e.ENTRA_JWKS_CACHE_TTL_MS,
    httpTimeoutMs: e.ENTRA_HTTP_TIMEOUT_MS,
    callbackRateLimit: {
      windowMs: e.ENTRA_CALLBACK_RATE_LIMIT_WINDOW_MS,
      maxRequests: e.ENTRA_CALLBACK_RATE_LIMIT_MAX_REQUESTS,
    },
  };
}

/**
 * Builder-portal Entra External ID sign-in (auth/05). Same shape as the
 * admin sign-in config, sourced from BUILDER_ENTRA_* env vars.
 *
 * PLACEHOLDER (2026-09-28): the builder app registration / user flow is
 * not yet provisioned in the Azure portal. `configured` stays false until
 * Karan provisions it — the builder callback 503s fail-closed meanwhile.
 */
function resolveBuilderEntraSignInConfig(e: ParsedEnv): EntraSignInConfig {
  const tenantSubdomain = e.BUILDER_ENTRA_TENANT_SUBDOMAIN;
  const tenantId = e.BUILDER_ENTRA_TENANT_ID;
  const clientId = e.BUILDER_ENTRA_CLIENT_ID;
  const userFlow = e.BUILDER_ENTRA_USER_FLOW;
  const clientSecret = e.BUILDER_ENTRA_CLIENT_SECRET;
  const configured =
    tenantSubdomain.length > 0 &&
    tenantId.length > 0 &&
    clientId.length > 0 &&
    userFlow.length > 0 &&
    clientSecret.length > 0;
  const base = `https://${tenantSubdomain}.ciamlogin.com/${tenantId}`;
  return {
    tenantSubdomain,
    tenantId,
    clientId,
    clientSecret,
    userFlow,
    configured,
    tokenEndpoint: `${base}/oauth2/v2.0/token`,
    jwksUri: `${base}/discovery/v2.0/keys`,
    issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
    logoutEndpoint: `${base}/oauth2/v2.0/logout`,
    jwksCacheTtlMs: e.ENTRA_JWKS_CACHE_TTL_MS,
    httpTimeoutMs: e.ENTRA_HTTP_TIMEOUT_MS,
    callbackRateLimit: {
      windowMs: e.ENTRA_CALLBACK_RATE_LIMIT_WINDOW_MS,
      maxRequests: e.ENTRA_CALLBACK_RATE_LIMIT_MAX_REQUESTS,
    },
  };
}

/**
 * Build the typed config. `env` is injectable so tests never touch the
 * real process environment. Empty-string values are treated as unset so
 * `VAR=` in a .env file falls back to the default instead of failing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    cleaned[key] = value === '' ? undefined : value;
  }

  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(formatConfigError(parsed.error));
  }
  const e = parsed.data;

  const databaseUrl = resolveDatabaseUrl(e);

  return {
    serviceName: 'feasly-api',
    version: packageVersion,
    env: e.NODE_ENV,
    databaseUrl,
    db: {
      poolMaxSize: e.DB_POOL_MAX_SIZE,
    },
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_MS,
      maxRequests: e.RATE_LIMIT_MAX_REQUESTS,
      maxTrackedKeys: e.RATE_LIMIT_MAX_TRACKED_KEYS,
    },
    sharedRateLimit: {
      sweepIntervalMs: e.RATE_LIMIT_SHARED_SWEEP_INTERVAL_MS,
    },
    lead: {
      rateLimit: {
        windowMs: e.LEAD_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.LEAD_RATE_LIMIT_MAX_REQUESTS,
      },
      dedupWindowDays: e.LEAD_DEDUP_WINDOW_DAYS,
      needsYouStaleDays: e.LEAD_NEEDS_YOU_STALE_DAYS,
      needsYouScanLimit: e.LEAD_NEEDS_YOU_SCAN_LIMIT,
      minSubmitMs: e.LEAD_MIN_SUBMIT_MS,
      callbackDateWindowDays: e.LEAD_CALLBACK_DATE_WINDOW_DAYS,
    },
    botChallenge: {
      enabled: e.TURNSTILE_SITE_KEY !== '' && e.TURNSTILE_SECRET_KEY !== '',
      siteKey: e.TURNSTILE_SITE_KEY,
      secretKey: e.TURNSTILE_SECRET_KEY,
      verifyUrl: e.TURNSTILE_VERIFY_URL,
      verifyTimeoutMs: e.TURNSTILE_VERIFY_TIMEOUT_MS,
      windowMs: e.BOT_CHALLENGE_WINDOW_MS,
      verifyRateLimit: {
        windowMs: e.BOT_CHALLENGE_VERIFY_WINDOW_MS,
        maxRequests: e.BOT_CHALLENGE_VERIFY_MAX_ATTEMPTS,
      },
    },
    sandboxPurge: {
      retentionDays: e.SANDBOX_PURGE_RETENTION_DAYS,
      dryRun: e.SANDBOX_PURGE_DRY_RUN,
    },
    apiKeyAuth: {
      authCacheTtlSeconds: e.API_KEY_AUTH_CACHE_TTL_SECONDS,
      acceptedModes: e.API_KEY_ACCEPTED_MODES,
    },
    payments: {
      provider: resolvePaymentsProvider(
        e.PAYMENTS_PROVIDER,
        e.NODE_ENV,
        e.STRIPE_SECRET_KEY,
      ),
      simulatedWebhookSecret: e.PAYMENTS_SIMULATED_WEBHOOK_SECRET,
      simulatedWebhookDelayMs: e.PAYMENTS_SIMULATED_WEBHOOK_DELAY_MS,
    },
    followUpEmail: {
      enabled: e.FOLLOW_UP_EMAIL_ENABLED,
      delayHours: e.FOLLOW_UP_EMAIL_DELAY_HOURS,
    },
    jobQueue: {
      batchSize: e.JOB_QUEUE_BATCH_SIZE,
      maxAttempts: e.JOB_QUEUE_MAX_ATTEMPTS,
      backoffBaseSeconds: e.JOB_QUEUE_BACKOFF_BASE_SECONDS,
      backoffMaxSeconds: e.JOB_QUEUE_BACKOFF_MAX_SECONDS,
      lockTimeoutSeconds: e.JOB_QUEUE_LOCK_TIMEOUT_SECONDS,
    },
    reminders: {
      unfinishedDelayHours: e.REMINDER_UNFINISHED_DELAY_HOURS,
      maxPerRun: e.REMINDER_MAX_PER_RUN,
    },
    shareLink: {
      ttlSeconds: e.SHARE_LINK_TTL_SECONDS,
      maxActive: e.SHARE_LINK_MAX_ACTIVE,
    },
    builderNotifications: {
      enabled: e.BUILDER_NOTIFICATIONS_ENABLED,
      maxAttempts: e.BUILDER_NOTIFICATION_MAX_ATTEMPTS,
      retryWindowHours: e.BUILDER_NOTIFICATION_RETRY_WINDOW_HOURS,
      claimLeaseMinutes: e.BUILDER_NOTIFICATION_CLAIM_LEASE_MINUTES,
      digestLocalHour: e.BUILDER_DIGEST_LOCAL_HOUR,
      digestTimeZone: e.BUILDER_DIGEST_TIMEZONE,
    },
    builderSettings: {
      supportEmail: e.BUILDER_SUPPORT_EMAIL ?? e.OPS_INBOX_EMAIL,
      supportResponseTime: e.BUILDER_SUPPORT_RESPONSE_TIME,
      embedLiveWindowDays: e.BUILDER_EMBED_LIVE_WINDOW_DAYS,
      embedLoaderUrl: `${e.APP_BASE_URL.replace(/\/+$/, '')}${e.BUILDER_EMBED_LOADER_PATH}`,
    },
    communityStatsRefresh: {
      minAssessmentCount: e.COMMUNITY_STATS_MIN_ASSESSMENTS,
      alertAfterConsecutiveFailures: e.COMMUNITY_STATS_ALERT_AFTER_FAILURES,
      pruneMinRows: e.COMMUNITY_STATS_PRUNE_MIN_ROWS,
    },
    communityLots: {
      city: e.COMMUNITY_LOTS_CITY,
      socrataBaseUrl: e.SOCRATA_BASE_URL,
      assessmentDatasetId: e.SOCRATA_DATASET_ID,
      boundariesDatasetId: e.COMMUNITY_LOTS_BOUNDARIES_DATASET_ID,
      establishedClasses: e.COMMUNITY_LOTS_ESTABLISHED_CLASSES,
      establishedStructures: e.COMMUNITY_LOTS_ESTABLISHED_STRUCTURES,
      minLotSqft: e.COMMUNITY_LOTS_MIN_LOT_SQFT,
      allowedDistrictPrefixes: e.COMMUNITY_LOTS_ALLOWED_DISTRICT_PREFIXES,
      pageSize: e.COMMUNITY_LOTS_PAGE_SIZE,
      requestDelayMs: e.COMMUNITY_LOTS_REQUEST_DELAY_MS,
      districtConcurrency: e.COMMUNITY_LOTS_DISTRICT_CONCURRENCY,
      httpTimeoutMs: e.COMMUNITY_LOTS_HTTP_TIMEOUT_MS,
      maxAttempts: e.COMMUNITY_LOTS_MAX_ATTEMPTS,
      staleAfterDays: e.COMMUNITY_LOTS_STALE_AFTER_DAYS,
      alertAfterConsecutiveFailures: e.COMMUNITY_LOTS_ALERT_AFTER_FAILURES,
      defaultLimit: e.COMMUNITY_LOTS_DEFAULT_LIMIT,
      maxLimit: e.COMMUNITY_LOTS_MAX_LIMIT,
      cacheMaxAgeSeconds: e.COMMUNITY_LOTS_CACHE_MAX_AGE_S,
    },
    neighbourhoodData: {
      providers: {
        schoolDirectory: e.NEIGHBOURHOOD_SCHOOL_DIRECTORY_PROVIDER,
        schoolDesignation: e.NEIGHBOURHOOD_SCHOOL_DESIGNATION_PROVIDER,
        schoolRatings: e.NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER,
        reviews: e.NEIGHBOURHOOD_REVIEWS_PROVIDER,
        amenities: e.NEIGHBOURHOOD_AMENITIES_PROVIDER,
        commute: e.NEIGHBOURHOOD_COMMUTE_PROVIDER,
      },
      socrataBaseUrl: e.SOCRATA_BASE_URL,
      schoolsDatasetId: e.NEIGHBOURHOOD_SCHOOLS_DATASET_ID,
      amenityCategories: e.NEIGHBOURHOOD_AMENITY_CATEGORIES,
      publicTreesDatasetId: e.NEIGHBOURHOOD_PUBLIC_TREES_DATASET_ID,
      communityBoundariesDatasetId: e.NEIGHBOURHOOD_COMMUNITY_BOUNDARIES_DATASET_ID,
      treeCoverThresholds: [e.NEIGHBOURHOOD_TREE_COVER_THRESHOLDS[0]!, e.NEIGHBOURHOOD_TREE_COVER_THRESHOLDS[1]!],
      amenitySearchRadiusM: e.NEIGHBOURHOOD_AMENITY_SEARCH_RADIUS_M,
      amenityCountRadiiM: [...e.NEIGHBOURHOOD_AMENITY_COUNT_RADII_M].sort((a, b) => a - b),
      communityMetricsTtlMs: e.NEIGHBOURHOOD_COMMUNITY_METRICS_TTL_MS,
      communityPointsDatasetId: e.NEIGHBOURHOOD_COMMUNITY_POINTS_DATASET_ID,
      osmOverpassUrl: e.NEIGHBOURHOOD_OSM_OVERPASS_URL,
      osmBbox: e.NEIGHBOURHOOD_OSM_BBOX,
      osmHttpTimeoutMs: e.NEIGHBOURHOOD_OSM_HTTP_TIMEOUT_MS,
      schoolDedupeRadiusM: e.NEIGHBOURHOOD_SCHOOL_DEDUPE_RADIUS_M,
      communityClass: e.NEIGHBOURHOOD_COMMUNITY_CLASS,
      communityStructures: csvToList(e.NEIGHBOURHOOD_COMMUNITY_STRUCTURES),
      commuteDestination: {
        name: e.NEIGHBOURHOOD_COMMUTE_DESTINATION_NAME,
        lat: e.NEIGHBOURHOOD_COMMUTE_DESTINATION_LAT,
        lng: e.NEIGHBOURHOOD_COMMUTE_DESTINATION_LNG,
      },
      httpTimeoutMs: e.NEIGHBOURHOOD_HTTP_TIMEOUT_MS,
      maxRows: e.NEIGHBOURHOOD_MAX_ROWS,
      refreshDayOfMonth: e.NEIGHBOURHOOD_REFRESH_DAY_OF_MONTH,
      alertAfterFailureDays: e.NEIGHBOURHOOD_ALERT_AFTER_FAILURE_DAYS,
      lotRadiusM: e.NEIGHBOURHOOD_LOT_RADIUS_M,
      lotMetricsTtlMs: e.NEIGHBOURHOOD_LOT_METRICS_TTL_MS,
    },
    backupCheck: {
      enabled: e.BACKUP_CHECK_ENABLED,
      subscriptionId: e.BACKUP_CHECK_SUBSCRIPTION_ID,
      resourceGroup: e.BACKUP_CHECK_RESOURCE_GROUP,
      serverName: e.BACKUP_CHECK_SERVER_NAME,
      minRetentionDays: e.BACKUP_CHECK_MIN_RETENTION_DAYS,
      maxStaleHours: e.BACKUP_CHECK_MAX_STALE_HOURS,
      imdsTokenUrl: e.BACKUP_CHECK_IMDS_TOKEN_URL,
      identityEndpoint: e.IDENTITY_ENDPOINT,
      identityHeader: e.IDENTITY_HEADER,
      armBaseUrl: e.BACKUP_CHECK_ARM_BASE_URL,
    },
    estimate: {
      rateLimit: {
        windowMs: e.ESTIMATE_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.ESTIMATE_RATE_LIMIT_MAX_REQUESTS,
      },
      tenantRateLimit: {
        windowMs: e.ESTIMATE_TENANT_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS,
      },
    },
    analytics: {
      rateLimit: {
        windowMs: e.ANALYTICS_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.ANALYTICS_RATE_LIMIT_MAX_REQUESTS,
      },
      funnelSourceGroupLimit: e.FUNNEL_SOURCE_GROUP_LIMIT,
    },
    webTelemetry: {
      rateLimit: {
        windowMs: e.WEB_TELEMETRY_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.WEB_TELEMETRY_RATE_LIMIT_MAX_REQUESTS,
      },
      maxTracesPerMinute: e.WEB_TELEMETRY_MAX_TRACES_PER_MINUTE,
    },
    adminSearch: {
      ipRateLimit: {
        windowMs: e.ADMIN_SEARCH_IP_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.ADMIN_SEARCH_IP_RATE_LIMIT_MAX_REQUESTS,
      },
      rateLimit: {
        windowMs: e.ADMIN_SEARCH_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.ADMIN_SEARCH_RATE_LIMIT_MAX_REQUESTS,
      },
      maxHitsPerKind: e.ADMIN_SEARCH_MAX_HITS_PER_KIND,
    },
    financeExport: {
      ipRateLimit: {
        windowMs: e.EXPORT_IP_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.EXPORT_IP_RATE_LIMIT_MAX_REQUESTS,
      },
      rateLimit: {
        windowMs: e.EXPORT_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.EXPORT_RATE_LIMIT_MAX_REQUESTS,
      },
      maxRows: e.EXPORT_MAX_ROWS,
      maxRangeDays: e.FINANCE_MAX_RANGE_DAYS,
    },
    webhook: {
      rateLimit: {
        windowMs: e.WEBHOOK_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.WEBHOOK_RATE_LIMIT_MAX_REQUESTS,
      },
    },
    auth: {
      jwtTtlSeconds: e.JWT_TTL_SECONDS,
      magicLinkTtlSeconds: e.MAGIC_LINK_TTL_SECONDS,
      magicLinkReissueCooldownMs: e.MAGIC_LINK_REISSUE_COOLDOWN_MS,
      magicLinkMaxSendsPerHour: e.MAGIC_LINK_MAX_SENDS_PER_HOUR,
      eraseConfirmLinkTtlSeconds: e.PRIVACY_ERASE_CONFIRM_LINK_TTL_SECONDS,
      adminApiKey: e.ADMIN_API_KEY,
      adminSessionTtlSeconds: e.ADMIN_SESSION_TTL_SECONDS,
      adminSessionIdleTimeoutSeconds: e.ADMIN_SESSION_IDLE_TIMEOUT_SECONDS,
      builderSessionTtlSeconds: e.BUILDER_SESSION_TTL_SECONDS,
      builderSessionIdleTimeoutSeconds: e.BUILDER_SESSION_IDLE_TIMEOUT_SECONDS,
      sessionActivityTouchIntervalSeconds: e.SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS,
      sessionReauthWindowSeconds: e.SESSION_REAUTH_WINDOW_SECONDS,
      invitationTtlSeconds: e.INVITATION_TTL_SECONDS,
    },
    entra: {
      tenantId: e.ENTRA_TENANT_ID,
      graphClientId: e.ENTRA_GRAPH_CLIENT_ID,
      graphClientSecret: e.ENTRA_GRAPH_CLIENT_SECRET,
      issuerDomain: e.ENTRA_ISSUER_DOMAIN,
      loginBaseUrl: 'https://login.microsoftonline.com',
      graphBaseUrl: 'https://graph.microsoft.com',
      configured:
        e.ENTRA_TENANT_ID !== '' &&
        e.ENTRA_GRAPH_CLIENT_ID !== '' &&
        e.ENTRA_GRAPH_CLIENT_SECRET !== '' &&
        e.ENTRA_ISSUER_DOMAIN !== '',
    },
    entraSignIn: resolveEntraSignInConfig(e),
    builderEntraSignIn: resolveBuilderEntraSignInConfig(e),
    corsOrigins: resolveCorsOrigins(e),
    siteUrl: e.SITE_URL,
    queues: {
      email: e.QUEUE_EMAIL_NAME,
      pdf: e.QUEUE_PDF_NAME,
      sheets: e.QUEUE_SHEETS_NAME,
    },
    email: {
      provider: e.EMAIL_PROVIDER,
      fromAddress: e.EMAIL_FROM_ADDRESS,
      fromName: e.EMAIL_FROM_NAME,
      postmarkServerToken: e.EMAIL_POSTMARK_SERVER_TOKEN,
      postmarkEndpoint: e.EMAIL_POSTMARK_ENDPOINT,
      acsConnectionString: e.EMAIL_ACS_CONNECTION_STRING,
      acsSendTimeoutMs: e.EMAIL_ACS_SEND_TIMEOUT_MS,
      sendMaxAttempts: e.EMAIL_SEND_MAX_ATTEMPTS,
      appBaseUrl: e.APP_BASE_URL,
      unsubscribeUrlBase: e.UNSUBSCRIBE_URL_BASE,
      unsubscribeTokenSecret: e.UNSUBSCRIBE_TOKEN_SECRET,
      unsubscribeTokenTtlSeconds: e.UNSUBSCRIBE_TOKEN_TTL_SECONDS,
      opsInbox: e.OPS_INBOX_EMAIL,
      opsAlertEmail: e.OPS_ALERT_EMAIL,
      opsAlertDedupeWindowMs: e.OPS_ALERT_DEDUPE_WINDOW_MS,
      logLinks: e.EMAIL_LOG_LINKS,
    },
    health: {
      dbTimeoutMs: e.HEALTH_DB_TIMEOUT_MS,
    },
    costEngine: {
      allowDraftCostData: e.COST_ENGINE_ALLOW_DRAFT,
    },
    propertyData: {
      socrataBaseUrl: e.SOCRATA_BASE_URL,
      datasetId: e.SOCRATA_DATASET_ID,
      cacheTtlMs: e.PROPERTY_CACHE_TTL_MS,
      httpTimeoutMs: e.PROPERTY_HTTP_TIMEOUT_MS,
      searchRowLimit: e.PROPERTY_SEARCH_ROW_LIMIT,
      suggestionLimit: e.PROPERTY_SUGGESTION_LIMIT,
      redevelopmentMinAgeYears: e.PROPERTY_REDEVELOPMENT_MIN_AGE_YEARS,
      dbCacheTtlMs: e.PROPERTY_DB_CACHE_TTL_MS,
      dbCacheTimeoutMs: e.PROPERTY_DB_CACHE_TIMEOUT_MS,
      httpCacheMaxAgeSeconds: e.PROPERTY_HTTP_CACHE_MAX_AGE_S,
    },
    landUse: {
      provider: e.LAND_USE_PROVIDER,
      socrataBaseUrl: e.SOCRATA_BASE_URL,
      datasetId: e.LAND_USE_DATASET_ID,
      cacheTtlMs: e.LAND_USE_CACHE_TTL_MS,
      dbCacheTtlMs: e.LAND_USE_DB_CACHE_TTL_MS,
      httpTimeoutMs: e.LAND_USE_HTTP_TIMEOUT_MS,
    },
    zoning: {
      city: e.ZONING_CITY,
      cacheMaxAgeSeconds: e.ZONING_CACHE_MAX_AGE_S,
      freshnessCacheTtlMs: e.ZONING_FRESHNESS_CACHE_TTL_MS,
      watch: {
        enabled: e.ZONING_WATCH_ENABLED,
        socrataBaseUrl: e.SOCRATA_BASE_URL,
        landUseDatasetId: e.LAND_USE_DATASET_ID,
        bylawPageUrl: e.ZONING_BYLAW_WATCH_URL,
        httpTimeoutMs: e.ZONING_WATCH_HTTP_TIMEOUT_MS,
        githubRepo: e.ZONING_WATCH_GITHUB_REPO,
        githubToken: e.ZONING_WATCH_GITHUB_TOKEN,
        githubApiUrl: e.ZONING_WATCH_GITHUB_API_URL,
      },
    },
    partners: {
      cacheTtlMs: e.PARTNERS_CACHE_TTL_MS,
      cacheMaxAgeSeconds: e.PARTNERS_CACHE_MAX_AGE_S,
    },
    cityDataFreshness: {
      socrataBaseUrl: e.SOCRATA_BASE_URL,
      datasetId: e.SOCRATA_DATASET_ID,
      httpTimeoutMs: e.PROPERTY_HTTP_TIMEOUT_MS,
      cacheTtlMs: e.CITY_DATA_FRESHNESS_CACHE_TTL_MS,
    },
    billing: {
      model: e.BILLING_MODEL,
      commissionRate: e.BILLING_COMMISSION_RATE,
      attributionWindowDays: e.BILLING_ATTRIBUTION_WINDOW_DAYS,
      reportingSlaDays: e.BILLING_REPORTING_SLA_DAYS,
      maxChargeRetries: e.BILLING_MAX_CHARGE_RETRIES,
      settlementThresholdHours: e.BILLING_SETTLEMENT_THRESHOLD_HOURS,
      dunningGraceDays: e.BILLING_DUNNING_GRACE_DAYS,
      tax: buildTaxConfig(e),
      ...(e.BILLING_STATEMENT_DESCRIPTOR
        ? { statementDescriptor: e.BILLING_STATEMENT_DESCRIPTOR }
        : {}),
      cardExpiryWarningDays: e.BILLING_CARD_EXPIRY_WARNING_DAYS,
      flatPlanName: e.BILLING_FLAT_PLAN_NAME,
      flatMonthlyCents: e.BILLING_FLAT_MONTHLY_CENTS,
      flatCurrency: e.BILLING_FLAT_CURRENCY,
      stripeSecretKey: enforceStripeTestMode(
        e.STRIPE_SECRET_KEY,
        e.NODE_ENV,
      ),
      stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
      stripeFlatPriceId: e.STRIPE_FLAT_PRICE_ID,
      isProduction: e.NODE_ENV === 'production',
    },
    sheets: {
      sheetId: e.SHEETS_SHEET_ID,
      serviceAccountEmail: e.SHEETS_SERVICE_ACCOUNT_EMAIL,
      serviceAccountPrivateKey: e.SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY,
      maxLeadsPerRun: e.SHEETS_MAX_LEADS_PER_RUN,
      apiScope: e.SHEETS_API_SCOPE,
      enabled:
        e.SHEETS_SHEET_ID.length > 0 &&
        e.SHEETS_SERVICE_ACCOUNT_EMAIL.length > 0,
      lagAfterHours: e.SHEETS_LAG_AFTER_HOURS,
      runStaleAfterMin: e.SHEETS_RUN_STALE_AFTER_MIN,
    },
    narrative: {
      provider: e.NARRATIVE_PROVIDER,
      apiKey: e.NARRATIVE_API_KEY,
      models: parseNarrativeModels(e.NARRATIVE_MODELS),
      timeoutMs: e.NARRATIVE_TIMEOUT_MS,
      endpoint: e.NARRATIVE_ENDPOINT,
      fallback: {
        endpoint: e.NARRATIVE_FALLBACK_ENDPOINT,
        apiKey: e.NARRATIVE_FALLBACK_API_KEY,
        models: parseNarrativeModels(e.NARRATIVE_FALLBACK_MODELS),
      },
    },
    communityNarratives: {
      enabled: e.COMMUNITY_NARRATIVE_ENABLED,
      schedule: e.COMMUNITY_NARRATIVE_SCHEDULE,
      runDay:
        e.COMMUNITY_NARRATIVE_RUN_DAY === 'last'
          ? 'last'
          : Number(e.COMMUNITY_NARRATIVE_RUN_DAY),
      retryDays: e.COMMUNITY_NARRATIVE_RETRY_DAYS,
      models: parseNarrativeModels(
        e.COMMUNITY_NARRATIVE_MODELS.trim() || e.NARRATIVE_MODELS,
      ),
      promptVersion: e.COMMUNITY_NARRATIVE_PROMPT_VERSION,
      maxPerRun: e.COMMUNITY_NARRATIVE_MAX_PER_RUN,
      adminBudgetMs: e.COMMUNITY_NARRATIVE_ADMIN_BUDGET_MS,
      tickBudgetMs: e.COMMUNITY_NARRATIVE_TICK_BUDGET_MS,
    },
    embed: {
      relayCodeTtlSeconds: e.EMBED_RELAY_CODE_TTL_SECONDS,
      sessionTtlSeconds: e.EMBED_SESSION_TTL_SECONDS,
      relayResendCooldownSeconds: e.EMBED_RELAY_RESEND_COOLDOWN_SECONDS,
    },
    waitlist: {
      consentVersion: e.WAITLIST_CONSENT_VERSION,
    },
    apiAccess: {
      dailyQuota: e.API_KEY_DAILY_QUOTA,
      monthlyQuota: e.API_KEY_MONTHLY_QUOTA,
      leadConsentVersion: e.API_LEAD_CONSENT_VERSION,
      quarantineLeads: e.API_KEY_LEADS_QUARANTINE,
    },
  };
}
