/**
 * Typed application configuration.
 *
 * BE0-001: minimal skeleton. BE0-002 replaces the hand parsing below with a
 * zod schema over env and adds every tunable (DATABASE_URL, rate limits,
 * JWT/magic-link TTLs, CORS origins, queue names).
 *
 * This module is the ONLY place allowed to touch `process.env` directly —
 * enforced by test/boundaries.test.ts. Everything else receives config
 * via constructor/factory injection.
 */

export type NodeEnv = 'development' | 'test' | 'staging' | 'production';

export interface ApiConfig {
  readonly serviceName: string;
  readonly version: string;
  readonly env: NodeEnv;
}

const VALID_ENVS: readonly NodeEnv[] = ['development', 'test', 'staging', 'production'];

function parseEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined || raw === '') return 'development';
  if ((VALID_ENVS as readonly string[]).includes(raw)) return raw as NodeEnv;
  throw new Error(
    `Invalid NODE_ENV=${JSON.stringify(raw)}; expected one of ${VALID_ENVS.join(', ')}`,
  );
}

/**
 * Build the typed config. `env` is injectable so tests never touch the
 * real process environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    serviceName: 'feasly-api',
    version: '0.1.0',
    env: parseEnv(env['NODE_ENV']),
  };
}
