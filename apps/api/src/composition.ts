/**
 * Composition root — the ONLY place concrete services are constructed.
 *
 * Wiring order: config → db (BE-1) → services → routes. Route handlers
 * receive service *interfaces*; nothing outside this module calls
 * `createXxxService` / `createXxxRoute` / `createXxxMiddleware`.
 */
import { loadConfig, type ApiConfig } from './config';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { createHealthService, type HealthService } from './services/health.service';
import { createEstimateService, type EstimateService } from './services/estimate.service';
import { createHealthRoute, type HealthRoute } from './routes/health.route';
import { createEstimateRoute, type EstimateRoute } from './routes/estimate.route';
import { createRateLimiter, type RateLimiter } from './middleware/rate-limit';
import { createRequestPipeline, type RequestPipeline } from './middleware/pipeline';

export interface AppComposition {
  readonly config: ApiConfig;
  readonly rateLimiter: RateLimiter;
  readonly requestPipeline: RequestPipeline;
  readonly healthService: HealthService;
  readonly healthRoute: HealthRoute;
  readonly estimateService: EstimateService;
  readonly estimateRoute: EstimateRoute;
}

/**
 * Build the full object graph. `env` is injectable so tests never touch
 * the real process environment (only config.ts may read it directly).
 */
export function createComposition(env?: NodeJS.ProcessEnv): AppComposition {
  const config: ApiConfig = loadConfig(env);
  // BE-1: const db = createDbClient({ connectionString: config.databaseUrl });
  //        const healthService = createHealthService({ config, dbPing: () => db.ping() });
  const rateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const requestPipeline: RequestPipeline = createRequestPipeline({ rateLimiter });
  const healthService: HealthService = createHealthService({ config });
  const healthRoute: HealthRoute = createHealthRoute({ health: healthService });
  // Cost engine: the versioned calibration table is injected here — the only
  // place the concrete table is chosen. A calibrated successor file swaps in
  // with a one-line change; every estimate pins which version it used.
  const estimateService: EstimateService = createEstimateService({
    costData: PLACEHOLDER_COST_DATA,
  });
  const estimateRoute: EstimateRoute = createEstimateRoute({ estimate: estimateService });
  return {
    config,
    rateLimiter,
    requestPipeline,
    healthService,
    healthRoute,
    estimateService,
    estimateRoute,
  };
}
