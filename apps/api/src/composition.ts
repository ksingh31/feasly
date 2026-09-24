/**
 * Composition root — the ONLY place concrete services are constructed.
 *
 * Wiring order: config → db (BE-1) → services → routes. Route handlers
 * receive service *interfaces*; nothing outside this module calls
 * `createXxxService` / `createXxxRoute`.
 */
import { loadConfig, type ApiConfig } from './config';
import { createHealthService, type HealthService } from './services/health.service';
import { createHealthRoute, type HealthRoute } from './routes/health.route';

export interface AppComposition {
  readonly config: ApiConfig;
  readonly healthService: HealthService;
  readonly healthRoute: HealthRoute;
}

/**
 * Build the full object graph. `env` is injectable so tests never touch
 * the real process environment (only config.ts may read it directly).
 */
export function createComposition(env?: NodeJS.ProcessEnv): AppComposition {
  const config: ApiConfig = loadConfig(env);
  // BE-1: const db = createDbClient({ connectionString: config.databaseUrl });
  const healthService: HealthService = createHealthService({ config });
  const healthRoute: HealthRoute = createHealthRoute({ health: healthService });
  return { config, healthService, healthRoute };
}
