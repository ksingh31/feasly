/**
 * Composition root — the ONLY place concrete services are constructed.
 *
 * Wiring order: config → db → stores → services → routes → pipelines.
 * Route handlers receive service *interfaces*; nothing outside this module
 * calls `createXxxService` / `createXxxStore` / `createXxxRoute` /
 * `createXxxMiddleware`.
 */
import { loadConfig, type ApiConfig } from './config';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { createDbClient, type DbClient } from './db/client';
import { createHealthService, type HealthService } from './services/health.service';
import { createEstimateService, type EstimateService } from './services/estimate.service';
import {
  createDrizzleEstimateStore,
  type EstimateStore,
} from './services/estimate.store';
import { createLeadService, type LeadService } from './services/lead.service';
import { createDrizzleLeadStore, type LeadStore } from './services/lead.store';
import {
  createAcsEmailProvider,
  createEmailService,
  createLogEmailProvider,
  createPostmarkEmailProvider,
  type EmailProvider,
  type EmailService,
} from './services/email';
import { createHealthRoute, type HealthRoute } from './routes/health.route';
import { createEstimateRoute, type EstimateRoute } from './routes/estimate.route';
import { createLeadRoute, type LeadRoute } from './routes/lead.route';
import { createRateLimiter, type RateLimiter } from './middleware/rate-limit';
import {
  createRequestPipeline,
  type LogEntry,
  type RequestPipeline,
} from './middleware/pipeline';

export interface AppComposition {
  readonly config: ApiConfig;
  readonly db: DbClient;
  readonly rateLimiter: RateLimiter;
  readonly requestPipeline: RequestPipeline;
  /** Tight limiter + pipeline for the public lead-gate endpoint. */
  readonly leadRateLimiter: RateLimiter;
  readonly leadPipeline: RequestPipeline;
  readonly healthService: HealthService;
  readonly healthRoute: HealthRoute;
  readonly estimateStore: EstimateStore;
  readonly estimateService: EstimateService;
  readonly estimateRoute: EstimateRoute;
  readonly leadStore: LeadStore;
  readonly leadService: LeadService;
  readonly leadRoute: LeadRoute;
  /** The one email service — all send paths funnel through here. */
  readonly emailService: EmailService;
}

export interface CompositionOptions {
  /**
   * Override the pipeline logger (the Functions adapters inject the
   * context logger so entries land in Application Insights; defaults to
   * console).
   */
  readonly logger?: (entry: LogEntry) => void;
  /**
   * Test seam: substitute the Drizzle-backed stores (e.g. PGlite-backed in
   * integration tests). Production wiring always uses the real stores.
   */
  readonly estimateStore?: EstimateStore;
  readonly leadStore?: LeadStore;
}

/**
 * Build the full object graph. `env` is injectable so tests never touch
 * the real process environment (only config.ts may read it directly).
 */
export function createComposition(
  env?: NodeJS.ProcessEnv,
  options: CompositionOptions = {},
): AppComposition {
  const config: ApiConfig = loadConfig(env);
  // Reno rates are uncalibrated draft placeholders (RENO-01): production
  // must never serve them, with or without the flag. Dev sets
  // COST_ENGINE_ALLOW_DRAFT=true to exercise the reno path.
  if (
    config.env === 'production' &&
    !PLACEHOLDER_COST_DATA.calibrated &&
    config.costEngine.allowDraftCostData
  ) {
    throw new Error(
      'Refusing to boot: COST_ENGINE_ALLOW_DRAFT=true in production while the cost table is uncalibrated.',
    );
  }
  const db: DbClient = createDbClient({
    connectionString: config.databaseUrl,
    maxPoolSize: config.db.poolMaxSize,
  });
  const rateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const requestPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter,
    logger: options.logger,
  });
  // The lead gate is public by design, so it gets its own deliberately
  // tight limiter on a separate pipeline — general API traffic is unaffected.
  const leadRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.lead.rateLimit.windowMs,
    maxRequests: config.lead.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const leadPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: leadRateLimiter,
    logger: options.logger,
  });
  const healthService: HealthService = createHealthService({ config });
  const healthRoute: HealthRoute = createHealthRoute({ health: healthService });
  const estimateStore: EstimateStore =
    options.estimateStore ?? createDrizzleEstimateStore({ db: db.db });
  // Cost engine: the versioned calibration table is injected here — the only
  // place the concrete table is chosen. A calibrated successor file swaps in
  // with a one-line change; every estimate pins which version it used.
  const estimateService: EstimateService = createEstimateService({
    costData: PLACEHOLDER_COST_DATA,
    store: estimateStore,
    allowDraftCostData: config.costEngine.allowDraftCostData,
  });
  const estimateRoute: EstimateRoute = createEstimateRoute({ estimate: estimateService });
  const leadStore: LeadStore =
    options.leadStore ?? createDrizzleLeadStore({ db: db.db });
  const leadService: LeadService = createLeadService({
    store: leadStore,
    estimateStore,
    dedupWindowDays: config.lead.dedupWindowDays,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
  });
  const leadRoute: LeadRoute = createLeadRoute({ leads: leadService });
  // Transactional email (story email/01): provider chosen by config.
  // 'log' is dev/test-only and refuses production; 'postmark' fails closed
  // without EMAIL_POSTMARK_SERVER_TOKEN; 'acs' (Karan-approved 2026-09-24)
  // fails closed without EMAIL_ACS_CONNECTION_STRING. Provisioning the ACS
  // resource + sender domain is a separate, Karan-gated step — never here.
  const emailProvider: EmailProvider = createEmailProvider(config);
  const emailService: EmailService = createEmailService({
    provider: emailProvider,
    fromAddress: config.email.fromAddress,
    fromName: config.email.fromName,
    appBaseUrl: config.email.appBaseUrl,
    unsubscribeBaseUrl: config.email.unsubscribeUrlBase,
    opsInbox: config.email.opsInbox,
  });
  return {
    config,
    db,
    rateLimiter,
    requestPipeline,
    leadRateLimiter,
    leadPipeline,
    healthService,
    healthRoute,
    estimateStore,
    estimateService,
    estimateRoute,
    leadStore,
    leadService,
    leadRoute,
    emailService,
  };
}

/**
 * Provider switch — the ONLY place a concrete email provider is chosen.
 * Kept outside createComposition's body flow for readability; still part of
 * the composition root (nothing else may construct providers).
 */
function createEmailProvider(config: ApiConfig): EmailProvider {
  switch (config.email.provider) {
    case 'postmark':
      return createPostmarkEmailProvider({
        serverToken: config.email.postmarkServerToken,
        fromAddress: config.email.fromAddress,
        endpoint: config.email.postmarkEndpoint,
      });
    case 'acs':
      return createAcsEmailProvider({
        connectionString: config.email.acsConnectionString,
        fromAddress: config.email.fromAddress,
      });
    case 'log':
    default:
      return createLogEmailProvider({
        env: config.env,
        logLinks: config.email.logLinks,
      });
  }
}
