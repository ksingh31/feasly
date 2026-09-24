/**
 * Thin health route. Routes are adapters, not logic:
 * validate input → call exactly one service method → format the response.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { HealthService, HealthStatus } from '../services/health.service';

export interface HealthRouteDeps {
  readonly health: HealthService;
}

export interface HealthRoute {
  handle(): Promise<HealthStatus>;
}

export function createHealthRoute(deps: HealthRouteDeps): HealthRoute {
  return {
    handle: (): Promise<HealthStatus> => deps.health.check(),
  };
}
