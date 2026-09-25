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

export type NodeEnv = 'development' | 'test' | 'staging' | 'production';

/** Split a comma-separated env value into a trimmed, non-empty list. */
function csvToList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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

  // The lead gate is public by design (callers are unauthenticated), so it
  // gets its own deliberately tight limiter — separate from the general one.
  LEAD_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  LEAD_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),

  // Estimates are the most expensive endpoint to leave unthrottled. These
  // defaults are the FROZEN limits from the canonical API registry
  // (TECH_PLAN.md §13.3 "Rate limiting tiers": public-anon tier,
  // estimates 20/hr/IP) — env-overridable, never hardcoded per endpoint.
  // Embed traffic is additionally aggregated per tenant so one builder's
  // viral page can't starve the endpoint for everyone else.
  ESTIMATE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
  ESTIMATE_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  ESTIMATE_TENANT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
  ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  // Analytics ingest is public by design (story consumer/01), so it gets
  // its own limiter — generous (300/min per IP) but separate from the
  // general API traffic.
  ANALYTICS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  ANALYTICS_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),

  // Stripe webhook receiver (billing/02): 100/min per IP (frozen registry).
  WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  WEBHOOK_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // Duplicate POSTs (same email + same estimate) inside this window return
  // the existing lead instead of inserting a duplicate (BE3-003).
  LEAD_DEDUP_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

  // JWT session lifetime is provisional — Karan has not confirmed magic-link-only V1
  // or the session lifetime. Revisit when the login ADR lands (BE-4).
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  // Magic-link lifetime decided by Karan 2026-09-24: 7 days (604_800 s).
  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  // INTERIM (api-mcp/01): pre-shared key for admin endpoints until
  // admin/01's session auth lands. Unset = admin endpoints fail closed.
  ADMIN_API_KEY: z.string().trim().min(1).optional(),

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
  // Base URL the web app lives at — magic-link / resume links are built
  // from this. Placeholder until the production domain is confirmed.
  APP_BASE_URL: z.string().url().default('https://feasly.example'),
  // Placeholder hook for the unsubscribe center (review-drafts/05, not built
  // yet): templates render `${UNSUBSCRIBE_URL_BASE}?token=…`.
  UNSUBSCRIBE_URL_BASE: z.string().url().default('https://feasly.example/unsubscribe'),
  // --- Unsubscribe center (story email/03) ---
  // HMAC secret for one-click unsubscribe tokens. Key Vault reference in
  // staging/production, never committed. Absent secret fails closed at
  // token issue/verify time with this variable named (same pattern as the
  // ACS provider credentials).
  UNSUBSCRIBE_TOKEN_SECRET: z.string().min(1).optional(),
  // One-click unsubscribe token validity: 30 days (story requirement).
  UNSUBSCRIBE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  // Team inbox for callback confirmations. Standing test email until Karan
  // names the ops inbox.
  OPS_INBOX_EMAIL: z.string().email().default('karanbirsingh667@gmail.com'),
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

export interface LeadConfig {
  /** Tight rate limiter for the public lead-gate endpoint. */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Dedup window in days: same email + address → existing lead. */
  readonly dedupWindowDays: number;
}

export interface EstimateConfig {
  /** Per-IP limiter for the public estimates endpoint (frozen: 20/hr/IP). */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
  /** Per-tenant limiter aggregating embed traffic (frozen: 20/hr/tenant). */
  readonly tenantRateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
}

export interface AnalyticsConfig {
  /** Generous rate limiter for the public analytics-ingest endpoint. */
  readonly rateLimit: Omit<RateLimitConfig, 'maxTrackedKeys'>;
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
   * INTERIM (api-mcp/01): pre-shared key for the admin endpoints, from
   * ADMIN_API_KEY. admin/01 replaces this with session auth. Undefined =
   * admin endpoints fail closed.
   */
  readonly adminApiKey: string | undefined;
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

export interface ApiConfig {
  readonly serviceName: string;
  /** Mirrors apps/api/package.json — the single source of truth. */
  readonly version: string;
  readonly env: NodeEnv;
  readonly databaseUrl: string;
  readonly db: DbConfig;
  readonly rateLimit: RateLimitConfig;
  readonly lead: LeadConfig;
  readonly estimate: EstimateConfig;
  readonly analytics: AnalyticsConfig;
  readonly webhook: WebhookConfig;
  readonly auth: AuthConfig;
  readonly corsOrigins: readonly string[];
  /** Public site URL — production `servers` entry in the OpenAPI spec. */
  readonly siteUrl: string;
  readonly queues: QueueConfig;
  readonly email: EmailConfig;
  readonly health: HealthConfig;
  readonly costEngine: CostEngineConfig;
  readonly propertyData: PropertyDataConfig;
  readonly billing: BillingConfig;
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
    throw new Error(
      'Invalid configuration:\n  - STRIPE_SECRET_KEY: non-production requires an sk_test_ key (no real charges in dev/staging)',
    );
  }
  return secretKey;
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
    lead: {
      rateLimit: {
        windowMs: e.LEAD_RATE_LIMIT_WINDOW_MS,
        maxRequests: e.LEAD_RATE_LIMIT_MAX_REQUESTS,
      },
      dedupWindowDays: e.LEAD_DEDUP_WINDOW_DAYS,
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
      adminApiKey: e.ADMIN_API_KEY,
    },
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
      appBaseUrl: e.APP_BASE_URL,
      unsubscribeUrlBase: e.UNSUBSCRIBE_URL_BASE,
      unsubscribeTokenSecret: e.UNSUBSCRIBE_TOKEN_SECRET,
      unsubscribeTokenTtlSeconds: e.UNSUBSCRIBE_TOKEN_TTL_SECONDS,
      opsInbox: e.OPS_INBOX_EMAIL,
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
    },
    billing: {
      model: e.BILLING_MODEL,
      commissionRate: e.BILLING_COMMISSION_RATE,
      attributionWindowDays: e.BILLING_ATTRIBUTION_WINDOW_DAYS,
      reportingSlaDays: e.BILLING_REPORTING_SLA_DAYS,
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
  };
}
