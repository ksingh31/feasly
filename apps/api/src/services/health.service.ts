/**
 * Health service — the single example service proving the composition pattern
 * in BE0-001. Real domain services (leads, estimates, magic links…) land in
 * later stories and follow this exact shape:
 *
 *   interface XxxService { ... } + createXxxService(deps: {...}): XxxService
 *
 * Services hold the logic ("composition services"). Only services and
 * src/composition.ts may import from src/db/.
 *
 * BE0-003: `check()` now reports dependency health. The DB ping is injected
 * (BE-1 wires the real Drizzle ping); a failing or hanging ping yields
 * `degraded` — never a 500.
 */
import type { ApiConfig } from '../config';
import { withTimeout } from '../lib/async';

export type DatabaseHealth = 'ok' | 'unreachable' | 'not-configured';

export interface HealthStatus {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly version: string;
  readonly checks: {
    readonly database: DatabaseHealth;
  };
}

export interface HealthService {
  /** Liveness plus dependency checks. Never throws for a sick dependency. */
  check(): Promise<HealthStatus>;
}

export interface HealthServiceDeps {
  readonly config: ApiConfig;
  /**
   * Resolves when the database answers, rejects when it doesn't.
   * Absent until BE-1 wires the real ping.
   */
  readonly dbPing?: () => Promise<void>;
}

export function createHealthService(deps: HealthServiceDeps): HealthService {
  const { config, dbPing } = deps;
  return {
    async check(): Promise<HealthStatus> {
      const base = { service: config.serviceName, version: config.version };
      if (dbPing === undefined) {
        return { ...base, status: 'ok', checks: { database: 'not-configured' } };
      }
      try {
        await withTimeout(dbPing(), config.health.dbTimeoutMs);
        return { ...base, status: 'ok', checks: { database: 'ok' } };
      } catch {
        return { ...base, status: 'degraded', checks: { database: 'unreachable' } };
      }
    },
  };
}
