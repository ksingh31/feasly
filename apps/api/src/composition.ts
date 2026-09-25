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
  createAnalyticsService,
  type AnalyticsService,
} from './services/analytics.service';
import {
  createDrizzleAnalyticsStore,
  type AnalyticsStore,
} from './services/analytics.store';
import {
  createAcsEmailProvider,
  createEmailService,
  createLogEmailProvider,
  createPostmarkEmailProvider,
  type EmailProvider,
  type EmailService,
} from './services/email';
import {
  createDrizzleMagicLinkStore,
  type MagicLinkStore,
} from './services/magic-link.store';
import {
  createMagicLinkService,
  type MagicLinkService,
} from './services/magic-link.service';
import {
  createUnsubscribeService,
  type UnsubscribeService,
} from './services/unsubscribe.service';
import {
  createNudgeService,
  type NudgeService,
} from './services/nudge.service';
import {
  createApiKeyService,
  type ApiKeyService,
  type ApiKeyStore,
  type ApiKeyAuditStore,
} from './services/api-key.service';
import {
  createDrizzleApiKeyAuditStore,
  createDrizzleApiKeyStore,
} from './services/api-key.store';
import {
  createApiKeyRoute,
  type ApiKeyRoute,
} from './routes/api-key.route';
import {
  createConfigAdminGuard,
  type AdminGuard,
} from './middleware/admin-guard';
import {
  createNoopBlockerChecker,
  createPrivacyService,
  type PrivacyService,
} from './services/privacy.service';
import {
  createDrizzlePrivacyStore,
  type PrivacyStore,
} from './services/privacy.store';
import {
  createDrizzleCommunityStatsService,
  type CommunityStatsService,
} from './services/community-stats.service';
import {
  createBuilderConfigService,
  type BuilderConfigService,
} from './services/builder-config.service';
import { BUILDER_CONFIGS } from './generated/builder-configs';
import { createHealthRoute, type HealthRoute } from './routes/health.route';
import { createEstimateRoute, type EstimateRoute } from './routes/estimate.route';
import { createLeadRoute, type LeadRoute } from './routes/lead.route';
import {
  createMagicLinkRoute,
  type MagicLinkRoute,
} from './routes/magic-link.route';
import {
  createUnsubscribeRoute,
  type UnsubscribeRoute,
} from './routes/unsubscribe.route';
import { createAnalyticsRoute, type AnalyticsRoute } from './routes/analytics.route';
import { createPrivacyRoute, type PrivacyRoute } from './routes/privacy.route';
import {
  createCommunityStatsRoute,
  type CommunityStatsRoute,
} from './routes/community-stats.route';
import {
  createEmbedConfigRoute,
  type EmbedConfigRoute,
} from './routes/embed-config.route';
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
  /**
   * consumer/03 — dedicated pipeline for the estimates endpoint: 20/hr/IP
   * plus per-tenant aggregation for embed traffic.
   */
  readonly estimateRateLimiter: RateLimiter;
  readonly estimateTenantRateLimiter: RateLimiter;
  readonly estimatePipeline: RequestPipeline;
  /** Generous limiter + pipeline for public analytics ingest. */
  readonly analyticsRateLimiter: RateLimiter;
  readonly analyticsPipeline: RequestPipeline;
  readonly healthService: HealthService;
  readonly healthRoute: HealthRoute;
  readonly estimateStore: EstimateStore;
  readonly estimateService: EstimateService;
  readonly estimateRoute: EstimateRoute;
  readonly leadStore: LeadStore;
  readonly leadService: LeadService;
  readonly leadRoute: LeadRoute;
  readonly analyticsStore: AnalyticsStore;
  readonly analyticsService: AnalyticsService;
  readonly analyticsRoute: AnalyticsRoute;
  /** The one email service — all send paths funnel through here. */
  readonly emailService: EmailService;
  readonly magicLinkStore: MagicLinkStore;
  /** consumer/02: verify + reissue lifecycle for magic-link tokens. */
  readonly magicLinkService: MagicLinkService;
  readonly magicLinkRoute: MagicLinkRoute;
  readonly unsubscribeService: UnsubscribeService;
  readonly unsubscribeRoute: UnsubscribeRoute;
  /** email/02: hourly 24h-nudge timer for unverified leads. */
  readonly nudgeService: NudgeService;
  /** api-mcp/01: API key issuance + storage (admin-only). */
  readonly apiKeyService: ApiKeyService;
  readonly apiKeyRoute: ApiKeyRoute;
  readonly adminGuard: AdminGuard;
  readonly privacyStore: PrivacyStore;
  readonly privacyService: PrivacyService;
  readonly privacyRoute: PrivacyRoute;
  /** Cache-first community stats (neighbourhood/01). */
  readonly communityStatsService: CommunityStatsService;
  readonly communityStatsRoute: CommunityStatsRoute;
  readonly builderConfigService: BuilderConfigService;
  readonly embedConfigRoute: EmbedConfigRoute;
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
  readonly magicLinkStore?: MagicLinkStore;
  readonly privacyStore?: PrivacyStore;
  readonly apiKeyStore?: ApiKeyStore;
  readonly apiKeyAuditStore?: ApiKeyAuditStore;
  /**
   * Test seam: substitute the database liveness probe (defaults to pinging
   * the real pool). Production wiring always uses the real ping.
   */
  readonly dbPing?: () => Promise<void>;
  readonly analyticsStore?: AnalyticsStore;
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
  // consumer/03 — estimates are the most expensive endpoint to leave
  // unthrottled: 20/hr per IP (frozen registry, TECH_PLAN.md §13.3), plus a
  // per-tenant bucket so one builder's embed traffic can't starve the
  // endpoint. Non-embed traffic has no tenantKey, so the tenant limiter
  // only engages for embeds.
  const estimateRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.estimate.rateLimit.windowMs,
    maxRequests: config.estimate.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const estimateTenantRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.estimate.tenantRateLimit.windowMs,
    maxRequests: config.estimate.tenantRateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const estimatePipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: estimateRateLimiter,
    extraLimiters: [
      {
        limiter: estimateTenantRateLimiter,
        keyFor: (request) =>
          request.tenantKey === undefined
            ? undefined
            : `tenant:${request.tenantKey}`,
        label: 'tenant',
      },
    ],
    logger: options.logger,
  });
  // HRD-06: the health endpoint reports real dependency state. A sick
  // database yields `degraded` (never a 500) via the service's timeout.
  // The probe is overridable for tests; production always pings the pool.
  const healthService: HealthService = createHealthService({
    config,
    dbPing: options.dbPing ?? (() => db.ping()),
  });
  // Analytics ingest is public by design (first-party), so it gets its own
  // generous limiter on a separate pipeline — funnel traffic never contends
  // with the general API limiter, and a flood of events never starves it.
  const analyticsRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.analytics.rateLimit.windowMs,
    maxRequests: config.analytics.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const analyticsPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: analyticsRateLimiter,
    logger: options.logger,
  });
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
  const magicLinkStore: MagicLinkStore =
    options.magicLinkStore ?? createDrizzleMagicLinkStore({ db: db.db });
  const analyticsStore: AnalyticsStore =
    options.analyticsStore ?? createDrizzleAnalyticsStore({ db: db.db });
  const analyticsService: AnalyticsService = createAnalyticsService({
    store: analyticsStore,
  });
  const analyticsRoute: AnalyticsRoute = createAnalyticsRoute({
    analytics: analyticsService,
  });
  // Transactional email (story email/01): provider chosen by config.
  // 'log' is dev/test-only and refuses production; 'postmark' fails closed
  // without EMAIL_POSTMARK_SERVER_TOKEN; 'acs' (Karan-approved 2026-09-24)
  // fails closed without EMAIL_ACS_CONNECTION_STRING. Provisioning the ACS
  // resource + sender domain is a separate, Karan-gated step — never here.
  // Built before the lead service: consumer/02 wires the magic-link email
  // into lead capture and the dedupe reissue path.
  const emailProvider: EmailProvider = createEmailProvider(config);
  const emailService: EmailService = createEmailService({
    provider: emailProvider,
    fromAddress: config.email.fromAddress,
    fromName: config.email.fromName,
    appBaseUrl: config.email.appBaseUrl,
    unsubscribeBaseUrl: config.email.unsubscribeUrlBase,
    opsInbox: config.email.opsInbox,
  });
  const leadService: LeadService = createLeadService({
    store: leadStore,
    estimateStore,
    magicLinks: magicLinkStore,
    email: emailService,
    appBaseUrl: config.email.appBaseUrl,
    dedupWindowDays: config.lead.dedupWindowDays,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
  });
  const leadRoute: LeadRoute = createLeadRoute({ leads: leadService });
  const magicLinkService: MagicLinkService = createMagicLinkService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    email: emailService,
    appBaseUrl: config.email.appBaseUrl,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
  });
  const magicLinkRoute: MagicLinkRoute = createMagicLinkRoute({
    magicLinks: magicLinkService,
  });
  // email/03 — one-click unsubscribe center. The HMAC secret arrives via
  // config (Key Vault in staging/production); the service fails closed
  // naming UNSUBSCRIBE_TOKEN_SECRET when it is absent.
  const unsubscribeService: UnsubscribeService = createUnsubscribeService({
    leads: leadStore,
    unsubscribeUrlBase: config.email.unsubscribeUrlBase,
    tokenSecret: config.email.unsubscribeTokenSecret,
    tokenTtlSeconds: config.email.unsubscribeTokenTtlSeconds,
  });
  // email/02 — hourly 24h nudge for unverified leads. Reuses the magic-link
  // store's issue/revoke path and the unsubscribe service's opt-out check.
  const nudgeService: NudgeService = createNudgeService({
    leads: leadStore,
    magicLinks: magicLinkStore,
    email: emailService,
    unsubscribe: unsubscribeService,
    appBaseUrl: config.email.appBaseUrl,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
  });
  // api-mcp/01 — API key issuance + storage (admin-only). The admin guard
  // is the INTERIM pre-shared-key guard until admin/01's session auth lands.
  const adminGuard: AdminGuard = createConfigAdminGuard({
    adminApiKey: config.auth.adminApiKey,
  });
  const apiKeyService: ApiKeyService = createApiKeyService({
    keys: options.apiKeyStore ?? createDrizzleApiKeyStore({ db: db.db }),
    audit:
      options.apiKeyAuditStore ?? createDrizzleApiKeyAuditStore({ db: db.db }),
  });
  const apiKeyRoute: ApiKeyRoute = createApiKeyRoute({
    apiKeys: apiKeyService,
    adminGuard,
  });
  const unsubscribeRoute: UnsubscribeRoute = createUnsubscribeRoute({
    unsubscribe: unsubscribeService,
  });
  const privacyStore: PrivacyStore =
    options.privacyStore ?? createDrizzlePrivacyStore({ db: db.db });
  // Erasure blockers (open disputes, in-review invoices) don't exist yet —
  // the dispute/invoice stories will replace this no-op with real checks.
  const privacyService: PrivacyService = createPrivacyService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    estimates: estimateStore,
    privacy: privacyStore,
    blockers: createNoopBlockerChecker(),
  });
  const privacyRoute: PrivacyRoute = createPrivacyRoute({
    privacy: privacyService,
  });
  // Community stats (neighbourhood/01): cache-first reads over the
  // community_stats table; populated by the seed script + monthly refresh.
  const communityStatsService: CommunityStatsService =
    createDrizzleCommunityStatsService({ db: db.db });
  const communityStatsRoute: CommunityStatsRoute = createCommunityStatsRoute({
    communityStats: communityStatsService,
  });
  // Builder embed config (embed/02): repo JSON inlined at build time wins,
  // DB tenants row is the fallback. Unknown key → 404 UNKNOWN_TENANT.
  // isDev mirrors the generator's rule (tools/generate-builder-configs.ts):
  // localhost origins are allowed everywhere except production.
  const builderConfigService: BuilderConfigService = createBuilderConfigService(
    {
      db: db.db,
      configs: BUILDER_CONFIGS,
      isDev: config.env !== 'production',
    },
  );
  const embedConfigRoute: EmbedConfigRoute = createEmbedConfigRoute({
    builderConfig: builderConfigService,
  });
  return {
    config,
    db,
    rateLimiter,
    requestPipeline,
    leadRateLimiter,
    leadPipeline,
    estimateRateLimiter,
    estimateTenantRateLimiter,
    estimatePipeline,
    analyticsRateLimiter,
    analyticsPipeline,
    healthService,
    healthRoute,
    estimateStore,
    estimateService,
    estimateRoute,
    leadStore,
    leadService,
    leadRoute,
    analyticsStore,
    analyticsService,
    analyticsRoute,
    emailService,
    magicLinkStore,
    magicLinkService,
    magicLinkRoute,
    unsubscribeService,
    unsubscribeRoute,
    nudgeService,
    apiKeyService,
    apiKeyRoute,
    adminGuard,
    privacyStore,
    privacyService,
    privacyRoute,
    communityStatsService,
    communityStatsRoute,
    builderConfigService,
    embedConfigRoute,
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
