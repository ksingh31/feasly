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

  // api-mcp/09: sandbox purge timer. Rows with sandbox=true older than
  // this are hard-deleted daily. DRY_RUN defaults true so the first run
  // only counts and logs — flip to false after verifying the blast radius.
  SANDBOX_PURGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  SANDBOX_PURGE_DRY_RUN: z.coerce.boolean().default(true),

  // neighbourhood/05: monthly community-stats refresh timer. Communities
  // with fewer fresh assessment records than this are skipped (logged, never
  // zero-filled). ALERT_AFTER_FAILURES consecutive timer failures fire the
  // community_stats_failed ops alert (admin/06).
  COMMUNITY_STATS_MIN_ASSESSMENTS: z.coerce.number().int().positive().default(10),
  COMMUNITY_STATS_ALERT_AFTER_FAILURES: z.coerce.number().int().positive().default(2),

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
  // EMB-06: relay-code lifetime (10 minutes per story) and the session-token
  // lifetime it exchanges into (12 hours per story). Both from env so tests
  // and staging can shorten them without code changes.
  EMBED_RELAY_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  EMBED_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  // EMB-06 AC3: per-code resend cooldown (60 seconds per story) so the
  // "session expired" re-issue button can't be hammered into a code fountain.
  EMBED_RELAY_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  // INTERIM (api-mcp/01): pre-shared key for admin endpoints until
  // admin/01's session auth lands. Unset = admin endpoints fail closed.
  ADMIN_API_KEY: z.string().trim().min(1).optional(),
  // Admin session lifetime (admin/01, D-02): 7 days, same as the magic links.
  ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
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
  // Bound on the ACS delivery poll (beginSend + pollUntilDone): the send is
  // synchronous in the HTTP request path, so an unbounded poll stalls the
  // response (2026-09-27: lead-gate "Sending..." hang). Past the deadline
  // the poll is aborted and the send fails LOUD — the lead row and token
  // are already committed, so a retry is safe (dedupe live-link path).
  // 6s default: the email service retries transient failures in-code
  // (EMAIL_SEND_MAX_ATTEMPTS), so the worst case is 6+1+6+1+6 ≈ 20s —
  // inside the frontend gate-submit timeout (25s).
  EMAIL_ACS_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(6_000),
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
  // Team inbox for callback confirmations. Standing test email until Karan
  // names the ops inbox.
  OPS_INBOX_EMAIL: z.string().email().default('karanbirsingh667@gmail.com'),
  // Ops alert recipient (admin/06). Standing test email until Karan names
  // an ops inbox.
  OPS_ALERT_EMAIL: z.string().email().default('karanbirsingh667@gmail.com'),
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
   * HRD-03: minimum ms between magic-link emails to the same address on the
   * reissue path (from MAGIC_LINK_REISSUE_COOLDOWN_MS).
   */
  readonly magicLinkReissueCooldownMs: number;
  /**
   * INTERIM (api-mcp/01): pre-shared key for the admin endpoints, from
   * ADMIN_API_KEY. admin/01 replaces this with session auth. Undefined =
   * admin endpoints fail closed.
   */
  readonly adminApiKey: string | undefined;
  /** Lifetime of an admin session cookie (admin/01, D-02: 7 days). */
  readonly adminSessionTtlSeconds: number;
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
   * Deadline for the ACS delivery poll, in milliseconds. The send runs
   * inline in the HTTP request path, so this bounds how long a stalled
   * delivery poll can hold the response open before it fails loud.
   * Default 6s: with in-code retries the worst case is 6+1+6+1+6 ≈ 20s,
   * inside the frontend gate-submit timeout (25s).
   */
  readonly acsPollTimeoutMs: number;
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
  readonly entra: EntraConfig;
  /** Microsoft Entra External ID sign-in (auth/02). Fail-closed while unprovisioned. */
  readonly entraSignIn: EntraSignInConfig;
  readonly corsOrigins: readonly string[];
  /** Public site URL — production `servers` entry in the OpenAPI spec. */
  readonly siteUrl: string;
  readonly queues: QueueConfig;
  readonly email: EmailConfig;
  readonly health: HealthConfig;
  readonly costEngine: CostEngineConfig;
  readonly propertyData: PropertyDataConfig;
  readonly billing: BillingConfig;
  readonly sandboxPurge: SandboxPurgeConfig;
  readonly sheets: SheetsConfig;
  readonly narrative: NarrativeConfig;
  readonly communityStatsRefresh: CommunityStatsRefreshConfig;
  readonly backupCheck: BackupCheckConfig;
  readonly embed: EmbedConfig;
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
    sandboxPurge: {
      retentionDays: e.SANDBOX_PURGE_RETENTION_DAYS,
      dryRun: e.SANDBOX_PURGE_DRY_RUN,
    },
    communityStatsRefresh: {
      minAssessmentCount: e.COMMUNITY_STATS_MIN_ASSESSMENTS,
      alertAfterConsecutiveFailures: e.COMMUNITY_STATS_ALERT_AFTER_FAILURES,
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
      adminApiKey: e.ADMIN_API_KEY,
      adminSessionTtlSeconds: e.ADMIN_SESSION_TTL_SECONDS,
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
      acsPollTimeoutMs: e.EMAIL_ACS_POLL_TIMEOUT_MS,
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
    },
    billing: {
      model: e.BILLING_MODEL,
      commissionRate: e.BILLING_COMMISSION_RATE,
      attributionWindowDays: e.BILLING_ATTRIBUTION_WINDOW_DAYS,
      reportingSlaDays: e.BILLING_REPORTING_SLA_DAYS,
      maxChargeRetries: e.BILLING_MAX_CHARGE_RETRIES,
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
    embed: {
      relayCodeTtlSeconds: e.EMBED_RELAY_CODE_TTL_SECONDS,
      sessionTtlSeconds: e.EMBED_SESSION_TTL_SECONDS,
      relayResendCooldownSeconds: e.EMBED_RELAY_RESEND_COOLDOWN_SECONDS,
    },
  };
}
