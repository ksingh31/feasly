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

  // Duplicate POSTs (same email + same estimate) inside this window return
  // the existing lead instead of inserting a duplicate (BE3-003).
  LEAD_DEDUP_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

  // JWT session lifetime is provisional — Karan has not confirmed magic-link-only V1
  // or the session lifetime. Revisit when the login ADR lands (BE-4).
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  // Magic-link lifetime decided by Karan 2026-09-24: 7 days (604_800 s).
  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),

  // A hanging dependency must not hang the health endpoint (BE0-003).
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform(csvToList),
  QUEUE_EMAIL_NAME: z.string().min(1).default('email-queue'),
  QUEUE_PDF_NAME: z.string().min(1).default('pdf-queue'),
  QUEUE_SHEETS_NAME: z.string().min(1).default('sheets-queue'),

  // Reno rates are uncalibrated draft placeholders (RENO-01). Renovation
  // estimates are refused unless this is true — and production refuses to
  // boot on draft data even then (see composition.ts). Set it in dev only.
  COST_ENGINE_ALLOW_DRAFT: z.coerce.boolean().default(false),
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

export interface DbConfig {
  readonly poolMaxSize: number;
}

export interface AuthConfig {
  /** Lifetime of the JWT session cookie issued after magic-link verification. */
  readonly jwtTtlSeconds: number;
  /** Lifetime of a single-use magic-link token. */
  readonly magicLinkTtlSeconds: number;
}

export interface QueueConfig {
  readonly email: string;
  readonly pdf: string;
  readonly sheets: string;
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

export interface ApiConfig {
  readonly serviceName: string;
  /** Mirrors apps/api/package.json — the single source of truth. */
  readonly version: string;
  readonly env: NodeEnv;
  readonly databaseUrl: string;
  readonly db: DbConfig;
  readonly rateLimit: RateLimitConfig;
  readonly lead: LeadConfig;
  readonly auth: AuthConfig;
  readonly corsOrigins: readonly string[];
  readonly queues: QueueConfig;
  readonly health: HealthConfig;
  readonly costEngine: CostEngineConfig;
}

/** Turn a ZodError into a readable startup failure naming each variable. */
function formatConfigError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${name}: ${issue.message}`;
  });
  return `Invalid configuration:\n${lines.join('\n')}`;
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
    auth: {
      jwtTtlSeconds: e.JWT_TTL_SECONDS,
      magicLinkTtlSeconds: e.MAGIC_LINK_TTL_SECONDS,
    },
    corsOrigins: resolveCorsOrigins(e),
    queues: {
      email: e.QUEUE_EMAIL_NAME,
      pdf: e.QUEUE_PDF_NAME,
      sheets: e.QUEUE_SHEETS_NAME,
    },
    health: {
      dbTimeoutMs: e.HEALTH_DB_TIMEOUT_MS,
    },
    costEngine: {
      allowDraftCostData: e.COST_ENGINE_ALLOW_DRAFT,
    },
  };
}
