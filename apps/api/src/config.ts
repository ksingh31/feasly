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

  DATABASE_URL: z
    .string()
    .min(1, 'Required: set DATABASE_URL to the Postgres connection string')
    .refine((value) => /^(postgres|postgresql):\/\//.test(value), {
      message: 'must be a Postgres connection string (postgres://… or postgresql://…)',
    }),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  // Safety valve: bounds the limiter's in-memory key map (DoS resistance).
  RATE_LIMIT_MAX_TRACKED_KEYS: z.coerce.number().int().positive().default(10_000),

  // Provisional defaults — Karan has not confirmed magic-link-only V1 or the
  // session/magic-link lifetimes. Revisit when the login ADR lands (BE-4).
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // A hanging dependency must not hang the health endpoint (BE0-003).
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform(csvToList),

  QUEUE_EMAIL_NAME: z.string().min(1).default('email-queue'),
  QUEUE_PDF_NAME: z.string().min(1).default('pdf-queue'),
  QUEUE_SHEETS_NAME: z.string().min(1).default('sheets-queue'),
});

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly maxTrackedKeys: number;
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

export interface ApiConfig {
  readonly serviceName: string;
  /** Mirrors apps/api/package.json — the single source of truth. */
  readonly version: string;
  readonly env: NodeEnv;
  readonly databaseUrl: string;
  readonly rateLimit: RateLimitConfig;
  readonly auth: AuthConfig;
  readonly corsOrigins: readonly string[];
  readonly queues: QueueConfig;
  readonly health: HealthConfig;
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

  return {
    serviceName: 'feasly-api',
    version: packageVersion,
    env: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_MS,
      maxRequests: e.RATE_LIMIT_MAX_REQUESTS,
      maxTrackedKeys: e.RATE_LIMIT_MAX_TRACKED_KEYS,
    },
    auth: {
      jwtTtlSeconds: e.JWT_TTL_SECONDS,
      magicLinkTtlSeconds: e.MAGIC_LINK_TTL_SECONDS,
    },
    corsOrigins: e.CORS_ORIGINS,
    queues: {
      email: e.QUEUE_EMAIL_NAME,
      pdf: e.QUEUE_PDF_NAME,
      sheets: e.QUEUE_SHEETS_NAME,
    },
    health: {
      dbTimeoutMs: e.HEALTH_DB_TIMEOUT_MS,
    },
  };
}
