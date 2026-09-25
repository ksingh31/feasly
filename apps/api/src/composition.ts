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
  createSandboxPurgeService,
  type SandboxPurgeService,
} from './services/sandbox-purge.service';
import { createDrizzleSandboxPurgeStore } from './services/sandbox-purge.store';
import {
  createSheetsSyncService,
  type SheetsSyncService,
} from './services/sheets-sync.service';
import {
  createOpsAlertsService,
  type OpsAlertsService,
} from './services/ops-alerts.service';
import { createDrizzleOpsAlertStore } from './services/ops-alerts.store';
import type { OpsAlertStore } from './services/ops-alerts.store';
import type { SheetsClient } from './services/sheets/sheets-client';
import { createGoogleSheetsClient } from './services/sheets/google-sheets-client';
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
  createAdminAuthRoute,
  type AdminAuthRoute,
} from './routes/admin-auth.route';
import {
  createAdminAuthService,
  type AdminAuthService,
  type AdminAllowlistStore,
  type AdminSessionStore,
} from './services/admin-auth.service';
import {
  createDrizzleAdminAllowlistStore,
  createDrizzleAdminSessionStore,
} from './services/admin-auth.store';
import {
  createSessionAdminGuard,
  type AdminGuard,
} from './middleware/admin-guard';
import {
  createAdminLeadsRoute,
  type AdminLeadsRoute,
} from './routes/admin-leads.route';
import {
  createAdminLeadsService,
  type AdminLeadsService,
} from './services/admin-leads.service';
import {
  createDrizzleAdminLeadsStore,
  type AdminLeadsStore,
} from './services/admin-leads.store';
import {
  createAdminEstimatesService,
  type AdminEstimatesService,
} from './services/admin-estimates.service';
import {
  createAdminEstimatesRoute,
  type AdminEstimatesRoute,
} from './routes/admin-estimates.route';
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
  createCommunityStatsRefreshService,
  createSocrataCommunityStatsSource,
  type CommunityStatsRefreshService,
} from './services/community-stats-refresh.service';
import {
  createDrizzleAdminAuditStore,
  type AdminAuditStore,
} from './services/admin-audit.store';
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
  createNarrativeRoute,
  type NarrativeRoute,
} from './routes/narrative.route';
import {
  createNarrativeService,
  type NarrativeService,
} from './services/narrative.service';
import { createLogNarrativeProvider } from './services/narrative/providers/log.provider';
import { createMetaNarrativeProvider } from './services/narrative/providers/meta.provider';
import type { NarrativeProvider } from './services/narrative/narrative.types';
import {
  createCommunityStatsRoute,
  type CommunityStatsRoute,
} from './routes/community-stats.route';
import {
  createCommunityStatsRefreshRoute,
  type CommunityStatsRefreshRoute,
} from './routes/community-stats-refresh.route';
import {
  createEmbedConfigRoute,
  type EmbedConfigRoute,
} from './routes/embed-config.route';
import {
  createPropertyService,
  type PropertyService,
} from './services/property.service';
import {
  createPropertyRoute,
  type PropertyRoute,
} from './routes/property.route';
import {
  createOpenApiRoute,
  type OpenApiRoute,
} from './routes/openapi.route';
import {
  createUsageService,
  type UsageService,
  type UsageStore,
} from './services/usage.service';
import { createDrizzleUsageStore } from './services/usage.store';
import {
  createUsageRoute,
  type UsageRoute,
} from './routes/usage.route';
import {
  createFunnelService,
  type FunnelService,
} from './services/funnel.service';
import { createDrizzleFunnelStore } from './services/funnel.store';
import type { FunnelStore } from './services/funnel.store';
import {
  createFunnelRoute,
  type FunnelRoute,
} from './routes/funnel.route';
import {
  createApiKeyRateLimitMiddleware,
  type ApiKeyRateLimitDeps,
} from './middleware/api-key-rate-limit';
import {
  createAttributionService,
  type AttributionService,
} from './services/billing/attribution.service';
import {
  createBillingAuditService,
  type BillingAuditService,
} from './services/billing/billing-audit.service';
import {
  createEmbedBillingHookService,
  type EmbedBillingHookService,
} from './services/billing/embed-billing-hook.service';
import {
  createStripeService,
  type StripeService,
} from './services/billing/stripe.service';
import {
  createCommissionService,
  type CommissionService,
} from './services/billing/commission.service';
import {
  createFlatPlanService,
  type FlatPlanService,
} from './services/billing/flat-plan.service';
import {
  createBillingWebhookService,
  type BillingWebhookService,
} from './services/billing/billing-webhook.service';
import {
  createInvoiceReviewerService,
  type InvoiceReviewerService,
} from './services/billing/invoice-reviewer.service';
import {
  createStripeWebhooksRoute,
  type StripeWebhooksRoute,
} from './routes/stripe-webhooks.route';
import {
  createMcpRoute,
  type McpRoute,
} from './routes/mcp.route';
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
  /** api-mcp/09: daily sandbox test-data purge timer. */
  readonly sandboxPurgeService: SandboxPurgeService;
  /** admin/04: hourly Google Sheets sync worker (Postgres is source of truth). */
  readonly sheetsSyncService: SheetsSyncService;
  /** admin/06: ops alerting (worker failures → deduped email). */
  readonly opsAlertsService: OpsAlertsService;
  /** api-mcp/01: API key issuance + storage (admin-only). */
  readonly apiKeyService: ApiKeyService;
  readonly apiKeyRoute: ApiKeyRoute;
  /** admin/01: magic-link + allowlist session auth for /admin/*. */
  readonly adminAuthService: AdminAuthService;
  readonly adminAuthRoute: AdminAuthRoute;
  readonly adminGuard: AdminGuard;
  /** admin/02: leads explorer (list, detail, notes, status, CSV export). */
  readonly adminLeadsService: AdminLeadsService;
  readonly adminLeadsRoute: AdminLeadsRoute;
  readonly adminLeadsStore: AdminLeadsStore;
  /** admin/03: read-only estimate lookup by ID. */
  readonly adminEstimatesService: AdminEstimatesService;
  readonly adminEstimatesRoute: AdminEstimatesRoute;
  readonly privacyStore: PrivacyStore;
  readonly privacyService: PrivacyService;
  readonly privacyRoute: PrivacyRoute;
  readonly narrativeService: NarrativeService;
  readonly narrativeRoute: NarrativeRoute;
  /** Cache-first community stats (neighbourhood/01). */
  readonly communityStatsService: CommunityStatsService;
  readonly communityStatsRoute: CommunityStatsRoute;
  /** Monthly refresh timer + manual admin trigger (neighbourhood/05). */
  readonly communityStatsRefreshService: CommunityStatsRefreshService;
  readonly communityStatsRefreshRoute: CommunityStatsRefreshRoute;
  /** Append-only admin audit log (neighbourhood/05; reused by later admin stories). */
  readonly adminAuditStore: AdminAuditStore;
  readonly builderConfigService: BuilderConfigService;
  readonly embedConfigRoute: EmbedConfigRoute;
  /** Property lookup (api-mcp/02): City of Calgary Socrata, cache-first. */
  readonly propertyService: PropertyService;
  readonly propertyRoute: PropertyRoute;
  /** api-mcp/03: OpenAPI spec (public, no auth). */
  readonly openApiRoute: OpenApiRoute;
  /** api-mcp/07: per-key rate limiting + usage metering. */
  readonly usageService: UsageService;
  readonly usageRoute: UsageRoute;
  /** admin/07: funnel dashboards — counts + conversion rates. */
  readonly funnelService: FunnelService;
  readonly funnelRoute: FunnelRoute;
  /**
   * api-mcp/07: per-key rate-limit middleware factory. Public adapters
   * wrap their handlers with this when a Bearer API key is present.
   */
  readonly withApiKeyRateLimit: ReturnType<typeof createApiKeyRateLimitMiddleware>;
  /** billing/01 foundation: lead→builder introduction lifecycle. */
  readonly attributionService: AttributionService;
  /** billing/02: append-only billing audit log. */
  readonly billingAuditService: BillingAuditService;
  /** embed/04: no-op billable-event hook for embed tenants (billing not enabled). */
  readonly embedBillingHookService: EmbedBillingHookService;
  /** billing/02: the only Stripe SDK touchpoint. */
  readonly stripeService: StripeService;
  /** billing/02: 1% commission engine (active when BILLING_MODEL=commission). */
  readonly commissionService: CommissionService;
  /** billing/02: flat subscription path (dormant until BILLING_MODEL=flat). */
  readonly flatPlanService: FlatPlanService;
  /** billing/02: Stripe webhook dispatch. */
  readonly billingWebhookService: BillingWebhookService;
  /** billing/02: daily review-window finalizer. */
  readonly invoiceReviewerService: InvoiceReviewerService;
  readonly stripeWebhooksRoute: StripeWebhooksRoute;
  /** Tight limiter + pipeline for the Stripe webhook receiver. */
  readonly webhookRateLimiter: RateLimiter;
  readonly webhookPipeline: RequestPipeline;
  /** MCP server (api-mcp/06): Streamable HTTP at POST /mcp/v1. */
  readonly mcpRoute: McpRoute;
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
  readonly adminSessionStore?: AdminSessionStore;
  readonly adminAllowlistStore?: AdminAllowlistStore;
  readonly adminAuditStore?: AdminAuditStore;
  readonly adminLeadsStore?: AdminLeadsStore;
  /**
   * Test seam: substitute the database liveness probe (defaults to pinging
   * the real pool). Production wiring always uses the real ping.
   */
  readonly dbPing?: () => Promise<void>;
  readonly analyticsStore?: AnalyticsStore;
  readonly usageStore?: UsageStore;
  readonly funnelStore?: FunnelStore;
  /**
   * Test seam: substitute the Google Sheets client (fake in unit tests).
   * Production wiring uses the real Google Sheets API client.
   */
  readonly sheetsClient?: SheetsClient;
  /**
   * Test seam: substitute the ops-alert dedupe store (fake in unit tests).
   * Production wiring uses the real `ops_alert_state` table.
   */
  readonly opsAlertStore?: OpsAlertStore;
}

/**
 * Build a SheetsClient from config. Throws if Sheets is not configured
 * (fail-closed) — the caller catches this and the worker alerts instead
 * of syncing.
 */
function createSheetsClientFromConfig(config: ApiConfig): SheetsClient {
  return createGoogleSheetsClient({
    sheetId: config.sheets.sheetId,
    serviceAccountEmail: config.sheets.serviceAccountEmail,
    privateKey: config.sheets.serviceAccountPrivateKey,
    apiScope: config.sheets.apiScope,
  });
}

/**
 * No-op Sheets client for when Sheets is disabled. The service checks
 * `enabled` before using the client, so these methods are never called
 * in practice; they throw if they somehow are.
 */
function createDisabledSheetsClient(): SheetsClient {
  const disabled = async (): Promise<never> => {
    throw new Error('Sheets sync is disabled (SHEETS_SHEET_ID not configured)');
  };
  return {
    upsertRows: disabled,
    checkAccess: disabled,
  };
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
  // Community stats (neighbourhood/01): cache-first reads over the
  // community_stats table; populated by the seed script + monthly refresh.
  // Created here (before the estimate service) so NBH-02 comparison can use it.
  const communityStatsService: CommunityStatsService =
    createDrizzleCommunityStatsService({ db: db.db });
  // Cost engine: the versioned calibration table is injected here — the only
  // place the concrete table is chosen. A calibrated successor file swaps in
  // with a one-line change; every estimate pins which version it used.
  const estimateService: EstimateService = createEstimateService({
    costData: PLACEHOLDER_COST_DATA,
    store: estimateStore,
    allowDraftCostData: config.costEngine.allowDraftCostData,
    communityStats: communityStatsService,
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
    magicLinkReissueCooldownMs: config.auth.magicLinkReissueCooldownMs,
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
  // api-mcp/09 — daily sandbox purge for test data. Hard-deletes sandbox
  // rows older than the retention window. Dry-run defaults true (first-run
  // safety) — flip SANDBOX_PURGE_DRY_RUN=false after verifying the blast radius.
  const sandboxPurgeService: SandboxPurgeService = createSandboxPurgeService({
    store: createDrizzleSandboxPurgeStore({ db: db.db }),
    retentionDays: config.sandboxPurge.retentionDays,
    dryRun: config.sandboxPurge.dryRun,
  });
  // admin/04 — hourly Google Sheets sync. Postgres is the source of truth;
  // the worker only writes the sheets_synced_at watermark. Fail-closed when
  // the Sheet ID or service-account email is unconfigured (placeholders).
  // The client is only constructed when Sheets is enabled; otherwise the
  // service runs in disabled mode and never touches the client.
  // admin/06 — ops alerting. The sheets-sync worker's lag/recovery hooks
  // land here; future workers (community-stats refresh, Stripe webhooks,
  // narrative worker) call opsAlertsService directly.
  const opsAlertsService: OpsAlertsService = createOpsAlertsService({
    email: emailService,
    store:
      options.opsAlertStore ?? createDrizzleOpsAlertStore({ db: db.db }),
    opsAlertEmail: config.email.opsAlertEmail,
    appBaseUrl: config.email.appBaseUrl,
    dedupeWindowMs: config.email.opsAlertDedupeWindowMs,
  });

  const sheetsSyncService: SheetsSyncService = createSheetsSyncService({
    leads: leadStore,
    estimates: estimateStore,
    sheets:
      options.sheetsClient ??
      (config.sheets.enabled
        ? createSheetsClientFromConfig(config)
        : createDisabledSheetsClient()),
    enabled: config.sheets.enabled,
    maxLeadsPerRun: config.sheets.maxLeadsPerRun,
    onSyncLagging: ({ consecutiveFailures, firstFailureAt }) =>
      opsAlertsService.notifyFailure('sheets_sync_failed', {
        consecutiveFailures,
        firstFailureAt,
      }),
    onSyncRecovered: () => opsAlertsService.notifyRecovered('sheets_sync_failed'),
  });
  // admin/01 — magic-link + allowlist session auth. The session guard
  // replaces the interim pre-shared-key guard; routes are untouched (they
  // depend on the AdminGuard interface).
  const adminSessionStore: AdminSessionStore =
    options.adminSessionStore ??
    createDrizzleAdminSessionStore({ db: db.db });
  const adminAllowlistStore: AdminAllowlistStore =
    options.adminAllowlistStore ??
    createDrizzleAdminAllowlistStore({ db: db.db });
  const adminAuditStore: AdminAuditStore =
    options.adminAuditStore ?? createDrizzleAdminAuditStore({ db: db.db });
  const adminAuthService: AdminAuthService = createAdminAuthService({
    allowlist: adminAllowlistStore,
    sessions: adminSessionStore,
    audit: adminAuditStore,
    magicLinks: magicLinkStore,
    email: emailService,
    appBaseUrl: config.email.appBaseUrl,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
    adminSessionTtlSeconds: config.auth.adminSessionTtlSeconds,
  });
  const adminAuthRoute: AdminAuthRoute = createAdminAuthRoute({
    adminAuth: adminAuthService,
    adminSessionTtlSeconds: config.auth.adminSessionTtlSeconds,
  });
  const adminGuard: AdminGuard = createSessionAdminGuard({
    adminAuth: adminAuthService,
  });
  // admin/02 — leads explorer. The store is injectable for tests.
  const adminLeadsStore: AdminLeadsStore =
    options.adminLeadsStore ?? createDrizzleAdminLeadsStore({ db: db.db });
  const adminLeadsService: AdminLeadsService = createAdminLeadsService({
    store: adminLeadsStore,
    leadStore,
    estimateStore,
    audit: adminAuditStore,
    maxExportRows: 10000,
  });
  const adminLeadsRoute: AdminLeadsRoute = createAdminLeadsRoute({
    adminLeads: adminLeadsService,
    adminGuard,
  });
  // admin/03 — read-only estimate lookup. Reuses the session guard; no
  // mutation endpoints exist.
  const adminEstimatesService: AdminEstimatesService =
    createAdminEstimatesService({
      estimateStore,
      leadStore,
    });
  const adminEstimatesRoute: AdminEstimatesRoute = createAdminEstimatesRoute({
    adminEstimates: adminEstimatesService,
    adminGuard,
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
  // Narrative worker (consumer/06): provider selected by config.
  // 'log' is the dev/test default (refuses production); 'meta' is the
  // Meta Llama API (Karan's pick) — fails closed until the API key is
  // configured in Key Vault.
  const narrativeProvider: NarrativeProvider =
    config.narrative.provider === 'meta'
      ? createMetaNarrativeProvider({
          apiKey: config.narrative.metaApiKey || undefined,
          model: config.narrative.model,
          endpoint: config.narrative.metaEndpoint,
        })
      : createLogNarrativeProvider();
  if (config.env === 'production' && config.narrative.provider === 'log') {
    throw new Error(
      'NARRATIVE_PROVIDER=log refuses production — configure the Meta API provider.',
    );
  }
  const narrativeService: NarrativeService = createNarrativeService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    estimates: estimateStore,
    provider: narrativeProvider,
    opsAlerts: opsAlertsService,
  });
  const narrativeRoute: NarrativeRoute = createNarrativeRoute({
    narrative: narrativeService,
  });
  // Community stats route (neighbourhood/01): uses the service created above
  // for the NBH-02 estimate comparison.
  const communityStatsRoute: CommunityStatsRoute = createCommunityStatsRoute({
    communityStats: communityStatsService,
  });
  // Community-stats monthly refresh (neighbourhood/05): recomputes
  // community_stats from fresh Socrata aggregates on a timer; ops can also
  // trigger it manually via POST /api/v1/admin/community-stats/refresh.
  // Two consecutive timer failures fire the community_stats_failed ops
  // alert (admin/06); recovery sends the all-clear and re-arms.
  // (adminAuditStore is defined above with the admin/01 session auth setup.)
  const communityStatsRefreshService: CommunityStatsRefreshService =
    createCommunityStatsRefreshService({
      stats: communityStatsService,
      source: createSocrataCommunityStatsSource({
        socrataBaseUrl: config.propertyData.socrataBaseUrl,
        datasetId: config.propertyData.datasetId,
        httpTimeoutMs: config.propertyData.httpTimeoutMs,
      }),
      minAssessmentCount: config.communityStatsRefresh.minAssessmentCount,
      alertAfterConsecutiveFailures:
        config.communityStatsRefresh.alertAfterConsecutiveFailures,
      onRefreshFailing: ({ consecutiveFailures, firstFailureAt }) =>
        opsAlertsService.notifyFailure('community_stats_failed', {
          consecutiveFailures,
          firstFailureAt,
        }),
      onRefreshRecovered: () =>
        opsAlertsService.notifyRecovered('community_stats_failed'),
    });
  const communityStatsRefreshRoute: CommunityStatsRefreshRoute =
    createCommunityStatsRefreshRoute({
      refresh: communityStatsRefreshService,
      audit: adminAuditStore,
      adminGuard,
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
  // Property lookup (api-mcp/02): Socrata-backed address autocomplete +
  // property records. Public by design (City open data); the MCP server and
  // embeds call these instead of hitting Socrata directly.
  const propertyService: PropertyService = createPropertyService(
    config.propertyData,
  );
  const propertyRoute: PropertyRoute = createPropertyRoute({
    property: propertyService,
  });
  const openApiRoute: OpenApiRoute = createOpenApiRoute({
    siteUrl: config.siteUrl,
    version: config.version,
  });
  // api-mcp/07 — per-key rate limiting + usage metering. The usage table
  // backs the sliding-window limiter; every accepted public API call
  // writes one row (429s write nothing).
  const usageService: UsageService = createUsageService({
    store: options.usageStore ?? createDrizzleUsageStore({ db: db.db }),
  });
  const usageRoute: UsageRoute = createUsageRoute({
    usage: usageService,
    apiKeys: apiKeyService,
    adminGuard,
  });
  // admin/07 — funnel dashboards. Aggregates the append-only analytics
  // events table into per-step counts + conversion rates. Admin-only.
  const funnelService: FunnelService = createFunnelService({
    store: options.funnelStore ?? createDrizzleFunnelStore({ db: db.db }),
  });
  const funnelRoute: FunnelRoute = createFunnelRoute({
    funnel: funnelService,
    adminGuard,
  });
  // api-mcp/07 — per-key rate limiting for public API routes. Wraps
  // handlers: Bearer key → authenticate → sliding-window check → record
  // usage on success. No key → passthrough (pipeline IP limiting applies).
  const withApiKeyRateLimit = createApiKeyRateLimitMiddleware({
    apiKeys: apiKeyService,
    usage: usageService,
  });
  // billing/01 foundation — the lead→builder introduction lifecycle the
  // commission engine bills against. Wired here now so the commission
  // service can read reported contracts (billing/02).
  const attributionService: AttributionService = createAttributionService({
    db: db.db,
    billing: config.billing,
  });
  // billing/02 commission engine. Every state change appends one
  // billing_events row; disputes freeze the charge clock and alert ops.
  const billingAuditService: BillingAuditService = createBillingAuditService({
    db: db.db,
  });
  // embed/04: no-op hook — records the event for future reconciliation,
  // returns billed:false. The real charge path replaces this, not beside it.
  const embedBillingHookService: EmbedBillingHookService =
    createEmbedBillingHookService({
      audit: billingAuditService,
    });
  const stripeService: StripeService = createStripeService({
    db: db.db,
    billing: config.billing,
  });
  const commissionService: CommissionService = createCommissionService({
    db: db.db,
    billing: config.billing,
    attribution: attributionService,
    audit: billingAuditService,
    stripe: stripeService,
    email: emailService,
    opsInbox: config.email.opsInbox,
  });
  // billing/02 flat path — dormant until BILLING_MODEL=flat. Both charge
  // paths are built; config selects the active one.
  const flatPlanService: FlatPlanService = createFlatPlanService({
    billing: config.billing,
    audit: billingAuditService,
    stripe: stripeService,
    email: emailService,
    opsInbox: config.email.opsInbox,
  });
  const billingWebhookService: BillingWebhookService =
    createBillingWebhookService({
      db: db.db,
      stripe: stripeService,
      audit: billingAuditService,
      commission: commissionService,
      flatPlan: flatPlanService,
    });
  const invoiceReviewerService: InvoiceReviewerService =
    createInvoiceReviewerService({
      billing: config.billing,
      commission: commissionService,
      audit: billingAuditService,
    });
  const stripeWebhooksRoute: StripeWebhooksRoute = createStripeWebhooksRoute({
    billingWebhooks: billingWebhookService,
  });
  // Stripe webhook receiver: 100/min per IP (frozen registry). The signature
  // is the auth — no bearer token exists for Stripe callbacks by design.
  const webhookRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.webhook.rateLimit.windowMs,
    maxRequests: config.webhook.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const webhookPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: webhookRateLimiter,
    logger: options.logger,
  });
  // MCP server (api-mcp/06): Streamable HTTP at POST /mcp/v1.
  // Thin wrapper over the shared services — the MCP package owns the
  // protocol, this route owns the wiring (auth + services).
  const mcpRoute: McpRoute = createMcpRoute({
    apiKeys: apiKeyService,
    property: propertyService,
    estimate: estimateService,
    leads: leadService,
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
    sandboxPurgeService,
    sheetsSyncService,
    opsAlertsService,
    apiKeyService,
    apiKeyRoute,
    adminAuthService,
    adminAuthRoute,
    adminGuard,
    adminLeadsService,
    adminLeadsRoute,
    adminLeadsStore,
    adminEstimatesService,
    adminEstimatesRoute,
    privacyStore,
    privacyService,
    privacyRoute,
    narrativeService,
    narrativeRoute,
    communityStatsService,
    communityStatsRoute,
    communityStatsRefreshService,
    communityStatsRefreshRoute,
    adminAuditStore,
    builderConfigService,
    embedConfigRoute,
    propertyService,
    propertyRoute,
    openApiRoute,
    usageService,
    usageRoute,
    funnelService,
    funnelRoute,
    withApiKeyRateLimit,
    attributionService,
    billingAuditService,
    embedBillingHookService,
    stripeService,
    commissionService,
    flatPlanService,
    billingWebhookService,
    invoiceReviewerService,
    stripeWebhooksRoute,
    webhookRateLimiter,
    webhookPipeline,
    mcpRoute,
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
