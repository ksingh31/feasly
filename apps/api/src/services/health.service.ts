/**
 * Health service — the single example service proving the composition pattern
 * in BE0-001. Real domain services (leads, estimates, magic links…) land in
 * later stories and follow this exact shape:
 *
 *   interface XxxService { ... } + createXxxService(deps: {...}): XxxService
 *
 * Services hold the logic ("composition services"). Only services and
 * src/composition.ts may import from src/db/.
 */
import type { ApiConfig } from '../config';

export interface HealthStatus {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
}

export interface HealthService {
  /** Current liveness status. BE0-003 extends this with a DB ping. */
  check(): Promise<HealthStatus>;
}

export interface HealthServiceDeps {
  readonly config: ApiConfig;
}

export function createHealthService(deps: HealthServiceDeps): HealthService {
  const { config } = deps;
  return {
    async check(): Promise<HealthStatus> {
      return {
        status: 'ok',
        service: config.serviceName,
        version: config.version,
      };
    },
  };
}
