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
import type { Builder } from '@feasly/contracts';
import { createDbClient, type DbClient } from './db/client';
import { sanitizeErrorMessage } from './lib/sanitize-error';
import { createHealthService, type HealthService } from './services/health.service';
import { createEstimateService, type EstimateService } from './services/estimate.service';
import {
  createDrizzleEstimateStore,
  type EstimateStore,
} from './services/estimate.store';
import { createLeadService, type LeadService } from './services/lead.service';
import {
  createDrizzleLeadStatusChangeStore,
  createDrizzleLeadStore,
  type LeadStatusChangeStore,
  type LeadStore,
} from './services/lead.store';
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
  UNFINISHED_ESTIMATE_REMINDER_JOB,
  type NudgeService,
} from './services/nudge.service';
import {
  createFollowUpService,
  NO_BUILDER_CONTACT_REMINDER_JOB,
  type FollowUpService,
} from './services/follow-up.service';
import {
  createDrizzleJobQueueStore,
  type JobQueueStore,
} from './services/job-queue.store';
import {
  createJobQueueService,
  type JobQueueService,
} from './services/job-queue.service';
import {
  createDrizzleShareLinkStore,
  type ShareLinkStore,
} from './services/share-link.store';
import {
  createAdminJobsRoute,
  type AdminJobsRoute,
} from './routes/admin-jobs.route';
import {
  createDrizzleLeadFollowUpStore,
  type LeadFollowUpStore,
} from './services/lead-follow-up.store';
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
  createDrizzleSheetsSyncRunStore,
  type SheetsSyncRunStore,
} from './services/sheets-sync-run.store';
import {
  createSheetsSyncStatusService,
  type SheetsSyncStatusService,
} from './services/sheets-sync-status.service';
import {
  createAdminSheetsStatusRoute,
  type AdminSheetsStatusRoute,
} from './routes/admin-sheets-status.route';
import {
  createAdminSheetsSyncNowRoute,
  type AdminSheetsSyncNowRoute,
} from './routes/admin-sheets-sync-now.route';
import {
  createOpsAlertsService,
  type OpsAlertsService,
} from './services/ops-alerts.service';
import { createDrizzleOpsAlertStore } from './services/ops-alerts.store';
import type { OpsAlertStore } from './services/ops-alerts.store';
import {
  createDrizzleSheetsSyncStateStore,
  type SheetsSyncStateStore,
} from './services/sheets-sync-state.store';
import {
  createBackupCheckService,
  type BackupCheckService,
} from './services/backup-check.service';
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
  createAdminEntraCallbackRoute,
  type AdminEntraCallbackRoute,
} from './routes/admin/entra-callback';
import {
  createBuilderAuthRoute,
  type BuilderAuthRoute,
} from './routes/builder-auth.route';
import {
  createBuilderEntraCallbackRoute,
  type BuilderEntraCallbackRoute,
} from './routes/builder/entra-callback';
import {
  createBuilderUsersRoute,
  type BuilderUsersRoute,
} from './routes/builder/users.route';
import {
  createBuilderLeadsRoute,
  type BuilderLeadsRoute,
} from './routes/builder-leads.route';
import {
  createBuilderCommentsRoute,
  type BuilderCommentsRoute,
} from './routes/builder-comments.route';
import {
  createAdminCommentsRoute,
  type AdminCommentsRoute,
} from './routes/admin-comments.route';
import {
  createBillingRoute,
  type BillingRoute,
} from './routes/billing.route';
import {
  createAdminDisputesRoute,
  type AdminDisputesRoute,
} from './routes/admin-disputes.route';
import {
  createAdminBillingRoute,
  type AdminBillingRoute,
} from './routes/admin-billing.route';
import {
  createBillingHealthService,
  type BillingHealthService,
} from './services/billing/billing-health.service';
import {
  createAdminAuthService,
  type AdminAuthService,
  type AdminSessionStore,
} from './services/admin-auth.service';
import {
  createBuilderAuthService,
  type BuilderAuthService,
  type BuilderAllowlistStore,
  type BuilderSessionStore,
} from './services/builder-auth.service';
import {
  createBuilderEntraCallbackService,
  type BuilderEntraCallbackService,
} from './services/builder-entra-callback.service';
import {
  createUserService,
  type UserService,
  type UserStore,
  type InvitationStore,
  type MembershipStore,
} from './services/user.service';
import {
  createEntraUserService,
  type EntraUserService,
} from './services/entra-user.service';
import {
  createDrizzleUserStore,
  createDrizzleInvitationStore,
  createDrizzleMembershipStore,
} from './services/user.store';
import {
  createBuilderLeadsService,
  type BuilderLeadsService,
} from './services/builder-leads.service';
import {
  createBuilderCommentsService,
  type BuilderCommentsService,
} from './services/builder-comments.service';
import {
  createDrizzleCommentStore,
  type CommentStore,
} from './services/builder-comments.store';
import {
  createBuilderService,
  type BuilderService,
} from './services/builder.service';
import {
  createLeadAssignmentService,
  type LeadAssignmentService,
} from './services/lead-assignment.service';
import {
  createDrizzleAdminSessionStore,
} from './services/admin-auth.store';
import { withSessionPolicy } from './services/session-policy';
import {
  createEntraTokenValidator,
  type EntraTokenValidator,
} from './services/entra-token-validator';
import {
  createEntraCallbackService,
  type EntraCallbackService,
} from './services/entra-callback.service';
import {
  createDrizzleBuilderAllowlistStore,
  createDrizzleBuilderSessionStore,
} from './services/builder-auth.store';
import {
  createSessionAdminGuard,
  createAdminSearchPipeline,
  type AdminGuard,
} from './middleware/admin-guard';
import {
  createAdminSearchRoute,
  type AdminSearchRoute,
} from './routes/admin-search.route';
import {
  createAdminSearchService,
  type AdminSearchService,
} from './services/admin-search.service';
import {
  createDrizzleAdminSearchStore,
  type AdminSearchStore,
} from './services/admin-search.store';
import {
  createSessionBuilderGuard,
  type BuilderGuard,
} from './middleware/builder-guard';
import {
  createPermissionGuard,
  type PermissionGuard,
} from './middleware/permission-guard';
import {
  createAuthContextService,
  type AuthContextService,
} from './services/auth-context.service';
import {
  createViewAsService,
  type ViewAsService,
} from './services/view-as.service';
import {
  createBuilderViewAsService,
  type BuilderViewAsService,
} from './services/builder-view-as.service';
import {
  createBuilderViewAsRoute,
  type BuilderViewAsRoute,
} from './routes/builder/view-as.route';
import {
  createAdminViewAsRoute,
  type AdminViewAsRoute,
} from './routes/admin-view-as.route';
import {
  createAdminUsersRoute,
  type AdminUsersRoute,
} from './routes/admin-users.route';
import {
  createAdminLeadsRoute,
  type AdminLeadsRoute,
} from './routes/admin-leads.route';
import {
  createAdminBuildersRoute,
  type AdminBuildersRoute,
} from './routes/admin-builders.route';
import {
  createAdminPartnersRoute,
  type AdminPartnersRoute,
} from './routes/admin-partners.route';
import { createPartnersRoute, type PartnersRoute } from './routes/partners.route';
import {
  createBuilderPartnersService,
  type BuilderPartnersService,
} from './services/builder-partners.service';
import {
  createDrizzleBuilderPartnerStore,
  type BuilderPartnerStore,
} from './services/builder-partners.store';
import {
  createAdminCalibrationRoute,
  type AdminCalibrationRoute,
} from './routes/admin-calibration.route';
import {
  createAdminCalibrationService,
  type AdminCalibrationService,
} from './services/admin-calibration.service';
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
import { createWebTelemetryRoute, type WebTelemetryRoute } from './routes/web-telemetry.route';
import {
  createWebTelemetryService,
  type WebTelemetryService,
} from './services/web-telemetry.service';
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
import { createOpenAiCompatibleNarrativeProvider } from './services/narrative/providers/openai-compatible.provider';
import type { NarrativeProvider } from './services/narrative/narrative.types';
import {
  createCommunityNarrativeService,
  type CommunityNarrativeService,
} from './services/community-narrative.service';
import { createDrizzleCommunityNarrativeStore } from './services/community-narrative.store';
import {
  createAdminCommunityNarrativesRoute,
  type AdminCommunityNarrativesRoute,
} from './routes/admin-community-narratives.route';
import {
  createCommunityStatsRoute,
  type CommunityStatsRoute,
} from './routes/community-stats.route';
import {
  createCityDataFreshnessRoute,
  type CityDataFreshnessRoute,
} from './routes/city-data-freshness.route';
import {
  createCityDataFreshnessService,
  type CityDataFreshnessService,
} from './services/city-data-freshness.service';
import { createZoningRoute, type ZoningRoute } from './routes/zoning.route';
import { createZoningService, type ZoningService } from './services/zoning.service';
import {
  createZoningWatchService,
  type ZoningWatchService,
} from './services/zoning-watch.service';
import {
  createDrizzleZoningWatchStore,
  type ZoningWatchStore,
} from './services/zoning-watch.store';
import { createGitHubIssuesClient } from './services/github-issues.client';
import {
  createCommunityStatsRefreshRoute,
  type CommunityStatsRefreshRoute,
} from './routes/community-stats-refresh.route';
import {
  createCommunityLivingRoute,
  type CommunityLivingRoute,
} from './routes/community-living.route';
import {
  createAdminNeighbourhoodDataRoute,
  type AdminNeighbourhoodDataRoute,
} from './routes/admin-neighbourhood-data.route';
import {
  createNeighbourhoodProviders,
  type NeighbourhoodProviders,
} from './services/neighbourhood-data/providers';
import {
  createDrizzleNeighbourhoodDataStore,
  type NeighbourhoodDataStore,
} from './services/neighbourhood-data/neighbourhood-data.store';
import {
  createNeighbourhoodRefreshService,
  type NeighbourhoodRefreshService,
} from './services/neighbourhood-data/neighbourhood-refresh.service';
import {
  createNeighbourhoodReadService,
  type NeighbourhoodReadService,
} from './services/neighbourhood-data/neighbourhood-read.service';
import {
  createEmbedConfigRoute,
  type EmbedConfigRoute,
} from './routes/embed-config.route';
import {
  createEmbedSessionRoute,
  type EmbedSessionRoute,
} from './routes/embed-session.route';
import {
  createEmbedRelayResendRoute,
  type EmbedRelayResendRoute,
} from './routes/embed-relay-resend.route';
import {
  createDrizzleEmbedRelayStore,
  type EmbedRelayStore,
} from './services/embed-relay.store';
import {
  createEmbedRelayService,
  type EmbedRelayService,
} from './services/embed-relay.service';
import {
  createPropertyService,
  type PropertyService,
} from './services/property.service';
import { createLandUseProvider } from './services/land-use.service';
import {
  createPropertyRoute,
  type PropertyRoute,
} from './routes/property.route';
// phase-2 wiring: the five live-API endpoints the web app needs.
import {
  createDrizzleReportSnapshotStore,
  type ReportSnapshotStore,
} from './services/report-snapshot.store';
import {
  createDrizzleCallbackRequestStore,
  type CallbackRequestStore,
} from './services/callback-request.store';
import {
  createDrizzlePartnerShareStore,
  type PartnerShareStore,
} from './services/partner-share.store';
import {
  createPreviewService,
  type PreviewService,
} from './services/preview.service';
import {
  createReportService,
  type ReportService,
} from './services/report.service';
import {
  createCallbackService,
  type CallbackService,
} from './services/callback.service';
import {
  createShareService,
  type ShareService,
} from './services/share.service';
import {
  createPreviewRoute,
  type PreviewRoute,
} from './routes/preview.route';
import {
  createReportRoute,
  type ReportRoute,
} from './routes/report.route';
import {
  createCallbackRoute,
  type CallbackRoute,
} from './routes/callback.route';
import {
  createShareRoute,
  type ShareRoute,
} from './routes/share.route';
// #520: renovation + other-city waitlists.
import {
  createDrizzleWaitlistStore,
  type WaitlistStore,
} from './services/waitlist.store';
import {
  createWaitlistService,
  type WaitlistService,
} from './services/waitlist.service';
import {
  createWaitlistRoute,
  type WaitlistRoute,
} from './routes/waitlist.route';
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
  createBillingService,
  type BillingService,
} from './services/billing/billing.service';
import {
  createStripeService,
  type StripeService,
} from './services/billing/stripe.service';
import {
  createCommissionService,
  type CommissionService,
} from './services/billing/commission.service';
import {
  createSimulatedPaymentProvider,
  type SimulatedPaymentProvider,
} from './services/billing/simulated-payment.provider';
import { createDrizzleSimulatedPaymentStore } from './services/billing/simulated-payment.store';
import {
  createSimulatedPaymentsService,
  type SimulatedPaymentsService,
} from './services/billing/simulated-payments.service';
import {
  createSimulatedPaymentsRoute,
  type SimulatedPaymentsRoute,
} from './routes/simulated-payments.route';
import {
  createFlatPlanService,
  type FlatPlanService,
} from './services/billing/flat-plan.service';
import {
  createCommissionCardService,
  type CommissionCardService,
} from './services/billing/commission-card.service';
import {
  createInvoicePdfService,
  type InvoicePdfService,
} from './services/billing/invoice-pdf.service';
import {
  createBillingWebhookService,
  type BillingWebhookService,
} from './services/billing/billing-webhook.service';
import {
  createInvoiceReviewerService,
  type InvoiceReviewerService,
} from './services/billing/invoice-reviewer.service';
import {
  createChargebackService,
} from './services/billing/chargeback.service';
import {
  createDisputeService,
  type DisputeService,
} from './services/billing/dispute.service';
import {
  createInvoiceSummaryStore,
  type InvoiceSummaryStore,
} from './services/billing/invoice-summary.store';
import {
  createBillingOverviewService,
  type BillingOverviewService,
} from './services/billing/billing-overview.service';
import {
  createBuilderBillingOverviewRoute,
  type BuilderBillingOverviewRoute,
} from './routes/builder/billing-overview.route';
import { createDrizzleBuilderNotificationStore } from './services/builder-notification.store';
import {
  createBuilderNotificationsService,
  type BuilderNotificationsService,
} from './services/builder-notifications.service';
import {
  createBuilderNotificationsRoute,
  type BuilderNotificationsRoute,
} from './routes/builder/notifications.route';
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
  createSharedCooldown,
  createSharedRateLimiter,
  type AnyRateLimiter,
  type SharedCounterStore,
} from './middleware/shared-rate-limit';
import { createDrizzleRateLimitStore } from './services/rate-limit.store';
import {
  createBotChallengeGate,
  type BotChallengeGate,
  type ChallengeVerifier,
} from './middleware/bot-challenge';
import { createTurnstileVerifier } from './services/turnstile.service';
import {
  createDrizzleCityDataCacheStore,
  type CityDataCacheInvalidator,
  type CityDataCacheStore,
} from './services/city-data-cache.store';
import { MAGIC_LINK_SEND_BUDGET_WINDOW_MS } from './services/magic-link.service';
import { resolveBuildTimeline } from './lib/build-timeline';
import {
  createRequestPipeline,
  type LogEntry,
  type RequestPipeline,
  type RequestPipelineDeps,
} from './middleware/pipeline';

export interface AppComposition {
  readonly config: ApiConfig;
  readonly db: DbClient;
  readonly rateLimiter: RateLimiter;
  readonly requestPipeline: RequestPipeline;
  /** Tight limiter + pipeline for the public lead-gate endpoint. */
  readonly leadRateLimiter: AnyRateLimiter;
  readonly leadPipeline: RequestPipeline;
  /**
   * consumer/03 — dedicated pipeline for the estimates endpoint: 20/hr/IP
   * plus per-tenant aggregation for embed traffic.
   */
  readonly estimateRateLimiter: AnyRateLimiter;
  readonly estimateTenantRateLimiter: AnyRateLimiter;
  readonly estimatePipeline: RequestPipeline;
  /** Generous limiter + pipeline for public analytics ingest. */
  readonly analyticsRateLimiter: RateLimiter;
  readonly analyticsPipeline: RequestPipeline;
  /** Tight limiter + pipeline for real-user-monitoring beacons (#830). */
  readonly webTelemetryRateLimiter: RateLimiter;
  readonly webTelemetryPipeline: RequestPipeline;
  readonly healthService: HealthService;
  readonly healthRoute: HealthRoute;
  readonly estimateStore: EstimateStore;
  readonly estimateService: EstimateService;
  readonly estimateRoute: EstimateRoute;
  readonly leadStore: LeadStore;
  readonly leadService: LeadService;
  readonly leadRoute: LeadRoute;
  /** phase-2 wiring: pre-gate preview (real figures, rows empty). */
  readonly previewService: PreviewService;
  readonly previewRoute: PreviewRoute;
  /** phase-2 wiring: immutable report snapshots + tier/sqft revisions. */
  readonly reportSnapshotStore: ReportSnapshotStore;
  readonly reportService: ReportService;
  readonly reportRoute: ReportRoute;
  /** phase-2 wiring: callback requests (name/phone/window). */
  readonly callbackRequestStore: CallbackRequestStore;
  readonly callbackService: CallbackService;
  readonly callbackRoute: CallbackRoute;
  /** #520: renovation + other-city waitlist signups. */
  readonly waitlistStore: WaitlistStore;
  readonly waitlistService: WaitlistService;
  readonly waitlistRoute: WaitlistRoute;
  /** phase-2 wiring: email-to-partner shares. */
  readonly partnerShareStore: PartnerShareStore;
  readonly shareService: ShareService;
  readonly shareRoute: ShareRoute;
  readonly analyticsStore: AnalyticsStore;
  readonly analyticsService: AnalyticsService;
  readonly analyticsRoute: AnalyticsRoute;
  /** #830: real-user monitoring beacon ingest (App Insights traces only). */
  readonly webTelemetryService: WebTelemetryService;
  readonly webTelemetryRoute: WebTelemetryRoute;
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
  /** #703: hourly post-report follow-up timer (flag default off). */
  readonly followUpService: FollowUpService;
  /** #838: Postgres-backed job queue (job-queue timer + admin view). */
  readonly jobQueueService: JobQueueService;
  /** #838: GET /v1/admin/ops/jobs. */
  readonly adminJobsRoute: AdminJobsRoute;
  /** api-mcp/09: daily sandbox test-data purge timer. */
  readonly sandboxPurgeService: SandboxPurgeService;
  /** admin/04: hourly Google Sheets sync worker (Postgres is source of truth). */
  readonly sheetsSyncService: SheetsSyncService;
  /** admin/06: ops alerting (worker failures → deduped email). */
  readonly opsAlertsService: OpsAlertsService;
  /**
   * admin/06: daily Postgres backup freshness probe (`backup_missed`).
   * Undefined when BACKUP_CHECK_ENABLED is false or the server details are
   * unconfigured — the timer adapter fails closed in that case.
   */
  readonly backupCheckService?: BackupCheckService;
  /** api-mcp/01: API key issuance + storage (admin-only). */
  readonly apiKeyService: ApiKeyService;
  readonly apiKeyRoute: ApiKeyRoute;
  /** auth/01: Entra identity + invitations (service only; routes land in auth/02+). */
  readonly userService: UserService;
  readonly userStore: UserStore;
  readonly invitationStore: InvitationStore;
  readonly membershipStore: MembershipStore;
  /** admin/01: magic-link + allowlist session auth for /admin/*. */
  readonly adminAuthService: AdminAuthService;
  readonly adminAuthRoute: AdminAuthRoute;
  /** auth/02: dedicated tight pipeline for the public Entra callback. */
  readonly entraCallbackRateLimiter: RateLimiter;
  readonly entraCallbackPipeline: RequestPipeline;
  readonly entraTokenValidator: EntraTokenValidator;
  readonly entraCallbackService: EntraCallbackService;
  readonly entraCallbackRoute: AdminEntraCallbackRoute;
  readonly adminGuard: AdminGuard;
  /** auth/04: session → user → effective permissions + tenant scoping. */
  readonly authContextService: AuthContextService;
  /** auth/04: requirePermission middleware (routes depend on this). */
  readonly permissionGuard: PermissionGuard;
  /** auth/04: view-as activation/exit + org switcher. */
  readonly viewAsService: ViewAsService;
  readonly adminViewAsRoute: AdminViewAsRoute;
  /** Builder-side view-as route (POST/DELETE /api/v1/builder/view-as). */
  readonly builderViewAsRoute: BuilderViewAsRoute;
  /** auth/03: admin user management (invite, edit, deactivate, delete). */
  readonly adminUsersRoute: AdminUsersRoute;
  /** Admin ⌘K global search: dedicated per-IP + per-session limiters + route. */
  readonly adminSearchIpRateLimiter: RateLimiter;
  readonly adminSearchSessionRateLimiter: RateLimiter;
  readonly adminSearchPipeline: RequestPipeline;
  readonly adminSearchService: AdminSearchService;
  readonly adminSearchRoute: AdminSearchRoute;
  /** embed/09: magic-link + allowlist session auth for /builder/*. */
  readonly builderAuthService: BuilderAuthService;
  readonly builderAuthRoute: BuilderAuthRoute;
  readonly builderGuard: BuilderGuard;
  /** auth/05: builder Entra sign-in (org accounts) + org user management. */
  readonly builderEntraCallbackService: BuilderEntraCallbackService;
  readonly builderEntraCallbackRoute: BuilderEntraCallbackRoute;
  readonly builderEntraCallbackPipeline: RequestPipeline;
  readonly builderUsersRoute: BuilderUsersRoute;
  /** embed/09: tenant-scoped lead pipeline for the builder portal. */
  readonly builderLeadsService: BuilderLeadsService;
  readonly builderLeadsRoute: BuilderLeadsRoute;
  /** billing/05: lead comments — one service, builder + admin routes. */
  readonly commentStore: CommentStore;
  readonly builderCommentsService: BuilderCommentsService;
  readonly builderCommentsRoute: BuilderCommentsRoute;
  readonly adminCommentsRoute: AdminCommentsRoute;
  readonly builderAllowlistStore: BuilderAllowlistStore;
  readonly builderSessionStore: BuilderSessionStore;
  /**
   * Builders table (embed/02 admin-UI migration): CRUD + lead assignment.
   * tenant_key stays the join key for billing/attribution.
   */
  readonly builderService: BuilderService;
  readonly adminBuildersRoute: AdminBuildersRoute;
  /** #888: builder partner disclosure — public list + admin CRUD. */
  readonly builderPartnersService: BuilderPartnersService;
  readonly partnersRoute: PartnersRoute;
  readonly adminPartnersRoute: AdminPartnersRoute;
  /** admin/02: leads explorer (list, detail, notes, status, CSV export). */
  readonly adminLeadsService: AdminLeadsService;
  readonly adminLeadsRoute: AdminLeadsRoute;
  readonly adminLeadsStore: AdminLeadsStore;
  /** admin/09: calibration console (read-only version + report + history). */
  readonly adminCalibrationService: AdminCalibrationService;
  readonly adminCalibrationRoute: AdminCalibrationRoute;
  /** admin/05: Sheets sync ops status panel + manual "Sync now" trigger. */
  readonly adminSheetsStatusRoute: AdminSheetsStatusRoute;
  readonly adminSheetsSyncNowRoute: AdminSheetsSyncNowRoute;
  /** admin/03: read-only estimate lookup by ID. */
  readonly adminEstimatesService: AdminEstimatesService;
  readonly adminEstimatesRoute: AdminEstimatesRoute;
  readonly privacyStore: PrivacyStore;
  readonly privacyService: PrivacyService;
  readonly privacyRoute: PrivacyRoute;
  readonly narrativeService: NarrativeService;
  readonly communityNarrativeService: CommunityNarrativeService;
  readonly adminCommunityNarrativesRoute: AdminCommunityNarrativesRoute;
  readonly narrativeRoute: NarrativeRoute;
  /** Cache-first community stats (neighbourhood/01). */
  readonly communityStatsService: CommunityStatsService;
  readonly communityStatsRoute: CommunityStatsRoute;
  /** City-data freshness for the landing trust strip (trust-strip/01): fetch-only, no db. */
  readonly cityDataFreshnessService: CityDataFreshnessService;
  readonly cityDataFreshnessRoute: CityDataFreshnessRoute;
  /** #687: zoning rules catalogue (pure data; no I/O). */
  readonly zoningService: ZoningService;
  readonly zoningRoute: ZoningRoute;
  /** #757: daily City-source watch + catalogue freshness. */
  readonly zoningWatchService: ZoningWatchService;
  /** Monthly refresh timer + manual admin trigger (neighbourhood/05). */
  readonly communityStatsRefreshService: CommunityStatsRefreshService;
  readonly communityStatsRefreshRoute: CommunityStatsRefreshRoute;
  /** #773: monthly neighbourhood data refresh (the only provider caller). */
  readonly neighbourhoodRefreshService: NeighbourhoodRefreshService;
  /** #773: request-path neighbourhood reads (tables only, no providers). */
  readonly neighbourhoodReadService: NeighbourhoodReadService;
  readonly adminNeighbourhoodDataRoute: AdminNeighbourhoodDataRoute;
  /** #777: public community living-nearby metrics. */
  readonly communityLivingRoute: CommunityLivingRoute;
  /** Append-only admin audit log (neighbourhood/05; reused by later admin stories). */
  readonly adminAuditStore: AdminAuditStore;
  readonly builderConfigService: BuilderConfigService;
  readonly embedConfigRoute: EmbedConfigRoute;
  /** Embed relay-code exchange (embed/06): single-use codes → session tokens. */
  readonly embedRelayStore: EmbedRelayStore;
  readonly embedRelayService: EmbedRelayService;
  readonly embedSessionRoute: EmbedSessionRoute;
  /** Embed relay-code re-issue (embed/06 AC3): expired/used codes → fresh code. */
  readonly embedRelayResendRoute: EmbedRelayResendRoute;
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
  /** billing/01: first charge path — attribution → draft invoice → review. */
  readonly embedBillingHookService: EmbedBillingHookService;
  /** billing/01: facade behind the /api/v1/billing/* routes. */
  readonly billingService: BillingService;
  /** billing/01: thin route for /api/v1/billing/*. */
  readonly billingRoute: BillingRoute;
  /** #531: Money page header — one-call builder billing overview. */
  readonly billingOverviewService: BillingOverviewService;
  /** #531: thin route for GET /api/v1/builder/billing/overview. */
  readonly builderBillingOverviewRoute: BuilderBillingOverviewRoute;
  /** #725: new-lead email, daily digest, preferences, billing recipients. */
  readonly builderNotificationsService: BuilderNotificationsService;
  /** #725: thin route for /api/v1/builder/notifications/preferences. */
  readonly builderNotificationsRoute: BuilderNotificationsRoute;
  /** billing/01 follow-on: dispute console backend (was OPS-009). */
  readonly disputeService: DisputeService;
  /** billing/01 follow-on: thin route for /api/v1/admin/disputes/*. */
  readonly adminDisputesRoute: AdminDisputesRoute;
  /** billing/03: read-only dashboard rollup for GET /api/v1/admin/billing. */
  readonly adminBillingRoute: AdminBillingRoute;
  /** billing/02: the only Stripe SDK touchpoint. */
  readonly stripeService: StripeService;
  /** billing/02: 1% commission engine (active when BILLING_MODEL=commission). */
  readonly commissionService: CommissionService;
  /** billing/02: flat subscription path (dormant until BILLING_MODEL=flat). */
  readonly flatPlanService: FlatPlanService;
  /** billing/02 (BILL-02): commission card-on-file (SetupIntent + status). */
  readonly commissionCardService: CommissionCardService;
  /** billing/02: Stripe webhook dispatch. */
  readonly billingWebhookService: BillingWebhookService;
  /** billing/02: daily review-window finalizer. */
  readonly invoiceReviewerService: InvoiceReviewerService;
  readonly stripeWebhooksRoute: StripeWebhooksRoute;
  /** #753: simulated-provider dev actions (404 unless PAYMENTS_PROVIDER=simulated). */
  readonly simulatedPaymentsService: SimulatedPaymentsService;
  readonly simulatedPaymentsRoute: SimulatedPaymentsRoute;
  /** Tight limiter + pipeline for the Stripe webhook receiver. */
  readonly webhookRateLimiter: RateLimiter;
  readonly webhookPipeline: RequestPipeline;
  /** MCP server (api-mcp/06): Streamable HTTP at POST /api/mcp/v1. */
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
  /** #729: shared rate-limit counters (default: Postgres via Drizzle). */
  readonly rateLimitStore?: SharedCounterStore;
  /** #788: Turnstile verifier seam (default: siteverify over HTTPS). */
  readonly challengeVerifier?: ChallengeVerifier;
  /** #756: shared City-data cache (tests inject an in-memory fake). */
  readonly cityDataCacheStore?: CityDataCacheStore;
  /** #757: zoning source watch state (default: Drizzle). */
  readonly zoningWatchStore?: ZoningWatchStore;
  /** #773: neighbourhood data tables (tests inject PGlite/fakes). */
  readonly neighbourhoodDataStore?: NeighbourhoodDataStore;
  /** #773: neighbourhood providers (tests inject fakes; default from config). */
  readonly neighbourhoodProviders?: NeighbourhoodProviders;
  readonly leadStore?: LeadStore;
  readonly leadStatusChangeStore?: LeadStatusChangeStore;
  /** #703: report-opened + follow-up stamps (default: Drizzle). */
  readonly leadFollowUpStore?: LeadFollowUpStore;
  /** #838: job queue persistence (default: Drizzle). */
  readonly jobQueueStore?: JobQueueStore;
  /** #838: link-only report shares (default: Drizzle). */
  readonly shareLinkStore?: ShareLinkStore;
  readonly magicLinkStore?: MagicLinkStore;
  readonly privacyStore?: PrivacyStore;
  readonly apiKeyStore?: ApiKeyStore;
  readonly apiKeyAuditStore?: ApiKeyAuditStore;
  readonly adminSessionStore?: AdminSessionStore;
  readonly builderSessionStore?: BuilderSessionStore;
  readonly builderAllowlistStore?: BuilderAllowlistStore;
  readonly userStore?: UserStore;
  readonly invitationStore?: InvitationStore;
  readonly membershipStore?: MembershipStore;
  readonly adminAuditStore?: AdminAuditStore;
  /** Builder partner store override (tests, #888). */
  readonly builderPartnerStore?: BuilderPartnerStore;
  readonly adminLeadsStore?: AdminLeadsStore;
  /** Admin global search store override (tests). */
  readonly adminSearchStore?: AdminSearchStore;
  /**
   * Test seam: substitute the database liveness probe (defaults to pinging
   * the real pool). Production wiring always uses the real ping.
   */
  readonly dbPing?: () => Promise<void>;
  readonly analyticsStore?: AnalyticsStore;
  readonly usageStore?: UsageStore;
  readonly funnelStore?: FunnelStore;
  /** phase-2 wiring: test seam for the report/callback/share stores. */
  readonly reportSnapshotStore?: ReportSnapshotStore;
  readonly callbackRequestStore?: CallbackRequestStore;
  readonly partnerShareStore?: PartnerShareStore;
  /** #520: test seam for the waitlist store. */
  readonly waitlistStore?: WaitlistStore;
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
  /**
   * Test seam: substitute the sheets-sync worker state store (fake in unit
   * tests). Production wiring uses the real `sheets_sync_state` table.
   */
  readonly sheetsSyncStateStore?: SheetsSyncStateStore;
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
  // Created before the pipelines: the #794 CSRF origin check audit-logs
  // every denial here.
  const adminAuditStore: AdminAuditStore =
    options.adminAuditStore ?? createDrizzleAdminAuditStore({ db: db.db });
  // #794 (#731 F-6): every pipeline refuses state-changing requests that
  // authenticate with an admin/builder session COOKIE unless Origin (or
  // Referer) is in CORS_ORIGINS. Bearer-header auth is unaffected.
  const csrf: RequestPipelineDeps['csrf'] = {
    allowlist: config.corsOrigins,
    onDenied: (denial) =>
      adminAuditStore.log({
        actorEmail: null,
        action: 'csrf.denied',
        detail: `method=${denial.method} cookie=${denial.cookie} reason=${denial.reason} correlation=${denial.correlationId}`,
      }),
  };
  const requestPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter,
    csrf,
    logger: options.logger,
  });
  // The lead gate is public by design, so it gets its own deliberately
  // tight limiter on a separate pipeline — general API traffic is unaffected.
  // #729: the money/mail limiters (lead capture, estimates, magic-link
  // resend) count in Postgres so their ceilings hold across scale-out. On a
  // store error each falls back to its in-memory limiter (the pre-#729
  // behavior), so a database blip never blocks or un-limits traffic.
  const rateLimitStore: SharedCounterStore =
    options.rateLimitStore ?? createDrizzleRateLimitStore({ db: db.db });
  const sharedLimiter = (
    scope: string,
    limit: { readonly windowMs: number; readonly maxRequests: number },
  ): AnyRateLimiter =>
    createSharedRateLimiter({
      store: rateLimitStore,
      scope,
      windowMs: limit.windowMs,
      maxRequests: limit.maxRequests,
      sweepIntervalMs: config.sharedRateLimit.sweepIntervalMs,
      fallback: createRateLimiter({
        windowMs: limit.windowMs,
        maxRequests: limit.maxRequests,
        maxTrackedKeys: config.rateLimit.maxTrackedKeys,
      }),
    });
  // #788 (owner decision on #750): invisible bot challenge, required only
  // from an IP that tripped the lead or estimate per-IP limiter, for
  // BOT_CHALLENGE_WINDOW_MS after the trip. Dormant (undefined) until the
  // Turnstile site key AND secret are configured — then the pipelines
  // behave exactly as before #788.
  const botChallenge: BotChallengeGate | undefined = config.botChallenge.enabled
    ? createBotChallengeGate({
        siteKey: config.botChallenge.siteKey,
        trips: createSharedCooldown({
          store: rateLimitStore,
          scope: 'bot-challenge:ip',
          cooldownMs: config.botChallenge.windowMs,
        }),
        attempts: sharedLimiter('bot-challenge:verify', config.botChallenge.verifyRateLimit),
        verifier:
          options.challengeVerifier ??
          createTurnstileVerifier({
            secretKey: config.botChallenge.secretKey,
            verifyUrl: config.botChallenge.verifyUrl,
            timeoutMs: config.botChallenge.verifyTimeoutMs,
          }),
      })
    : undefined;
  const leadRateLimiter: AnyRateLimiter = sharedLimiter('lead:ip', config.lead.rateLimit);
  const leadPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: leadRateLimiter,
    challenge: botChallenge,
    csrf,
    logger: options.logger,
  });
  // consumer/03 — estimates are the most expensive endpoint to leave
  // unthrottled: 20/hr per IP (frozen registry, TECH_PLAN.md §13.3), plus a
  // per-tenant bucket so one builder's embed traffic can't starve the
  // endpoint. Non-embed traffic has no tenantKey, so the tenant limiter
  // only engages for embeds.
  const estimateRateLimiter: AnyRateLimiter = sharedLimiter(
    'estimate:ip',
    config.estimate.rateLimit,
  );
  const estimateTenantRateLimiter: AnyRateLimiter = sharedLimiter(
    'estimate:tenant',
    config.estimate.tenantRateLimit,
  );
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
    challenge: botChallenge,
    csrf,
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
    csrf,
    logger: options.logger,
  });
  // auth/02 — the Entra callback is public by design (it IS the sign-in),
  // so it gets its own deliberately tight limiter on a separate pipeline:
  // 10 attempts per IP per 15 min (frozen registry). Entra owns credential
  // brute-force; this stops authorization-code replay abuse.
  const entraCallbackRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.entraSignIn.callbackRateLimit.windowMs,
    maxRequests: config.entraSignIn.callbackRateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const entraCallbackPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: entraCallbackRateLimiter,
    csrf,
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
  // Builder configs (EMB-02/03): created before estimate/lead services so
  // embed tenant keys can be validated server-side. Resolution order: DB
  // builders row first, repo JSON as fallback. Unknown key → 404 UNKNOWN_TENANT.
  const builderConfigService: BuilderConfigService = createBuilderConfigService({
    db: db.db,
    configs: BUILDER_CONFIGS,
    isDev: config.env !== 'production',
  });
  const estimateService: EstimateService = createEstimateService({
    costData: PLACEHOLDER_COST_DATA,
    store: estimateStore,
    allowDraftCostData: config.costEngine.allowDraftCostData,
    communityStats: communityStatsService,
    builderConfigs: builderConfigService,
  });
  const estimateRoute: EstimateRoute = createEstimateRoute({ estimate: estimateService });
  const leadStore: LeadStore =
    options.leadStore ?? createDrizzleLeadStore({ db: db.db });
  const leadStatusChangeStore: LeadStatusChangeStore =
    options.leadStatusChangeStore ??
    createDrizzleLeadStatusChangeStore({ db: db.db });
  const leadFollowUpStore: LeadFollowUpStore =
    options.leadFollowUpStore ?? createDrizzleLeadFollowUpStore({ db: db.db });
  const magicLinkStore: MagicLinkStore =
    options.magicLinkStore ?? createDrizzleMagicLinkStore({ db: db.db });
  // #838 — Postgres-backed job queue. Built early so the unsubscribe
  // service can cancel a lead's queued reminders; handlers bind late (the
  // reminder services are built further down).
  const jobQueueStore: JobQueueStore =
    options.jobQueueStore ?? createDrizzleJobQueueStore({ db: db.db });
  const jobQueueService: JobQueueService = createJobQueueService({
    store: jobQueueStore,
    handlers: () => ({
      [UNFINISHED_ESTIMATE_REMINDER_JOB]: async (job) => {
        if (job.leadId) await nudgeService.sendReminder(job.leadId);
      },
      [NO_BUILDER_CONTACT_REMINDER_JOB]: async (job) => {
        if (job.leadId) await followUpService.sendReminder(job.leadId);
      },
    }),
    batchSize: config.jobQueue.batchSize,
    maxAttempts: config.jobQueue.maxAttempts,
    backoffBaseSeconds: config.jobQueue.backoffBaseSeconds,
    backoffMaxSeconds: config.jobQueue.backoffMaxSeconds,
    lockTimeoutSeconds: config.jobQueue.lockTimeoutSeconds,
  });
  const analyticsStore: AnalyticsStore =
    options.analyticsStore ?? createDrizzleAnalyticsStore({ db: db.db });
  const analyticsService: AnalyticsService = createAnalyticsService({
    store: analyticsStore,
  });
  const analyticsRoute: AnalyticsRoute = createAnalyticsRoute({
    analytics: analyticsService,
  });
  // #830: browser vitals + JS errors → one JSON trace per item, queryable in
  // App Insights as `traces | where message startswith '{"event":"web_'`
  // (docs/ops/web-telemetry.md). Own tight limiter (10/min per IP) plus a
  // per-instance trace budget, so one client can't exhaust the Log
  // Analytics daily cap and silence every server trace for the day.
  const webTelemetryRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.webTelemetry.rateLimit.windowMs,
    maxRequests: config.webTelemetry.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const webTelemetryPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: webTelemetryRateLimiter,
    csrf,
    logger: options.logger,
  });
  const webTelemetryService: WebTelemetryService = createWebTelemetryService({
    onTrace: (trace) => console.info(JSON.stringify(trace)),
    maxTracesPerMinute: config.webTelemetry.maxTracesPerMinute,
  });
  const webTelemetryRoute: WebTelemetryRoute = createWebTelemetryRoute({
    webTelemetry: webTelemetryService,
  });
  // Transactional email (story email/01): provider chosen by config.
  // 'log' is dev/test-only and refuses production; 'postmark' fails closed
  // without EMAIL_POSTMARK_SERVER_TOKEN; 'acs' (Karan-approved 2026-09-24)
  // fails closed without EMAIL_ACS_CONNECTION_STRING. Provisioning the ACS
  // resource + sender domain is a separate, Karan-gated step — never here.
  // Built before the lead service: consumer/02 wires the magic-link email
  // into lead capture and the dedupe reissue path.
  const emailProvider: EmailProvider = createEmailProvider(config);
  const reportEmailTimeline = resolveBuildTimeline(config.zoning.city);
  const emailService: EmailService = createEmailService({
    provider: emailProvider,
    fromAddress: config.email.fromAddress,
    fromName: config.email.fromName,
    appBaseUrl: config.email.appBaseUrl,
    unsubscribeBaseUrl: config.email.unsubscribeUrlBase,
    opsInbox: config.email.opsInbox,
    // In-code retry budget (Karan 2026-09-27: at least 2 retries, no queue).
    maxAttempts: config.email.sendMaxAttempts,
    // #823: the report email's typical build timeline, for the served city.
    ...(reportEmailTimeline ? { buildTimeline: reportEmailTimeline } : {}),
  });
  // email/03 — one-click unsubscribe center. The HMAC secret arrives via
  // config (Key Vault in staging/production); the service fails closed
  // naming UNSUBSCRIBE_TOKEN_SECRET when it is absent. Created before the
  // lead/magic-link services so the magic-link email footer can mint
  // tokenized preference-page URLs.
  const unsubscribeService: UnsubscribeService = createUnsubscribeService({
    leads: leadStore,
    unsubscribeUrlBase: config.email.unsubscribeUrlBase,
    tokenSecret: config.email.unsubscribeTokenSecret,
    tokenTtlSeconds: config.email.unsubscribeTokenTtlSeconds,
    jobs: jobQueueService,
  });
  // Builders table (embed/02 admin-UI migration): runtime source of truth
  // for builder config. tenant_key stays the join key for billing,
  // sessions, and the embed config lookup. Created before the lead
  // service so embed lead capture can dual-write builder_id in the same
  // insert (the lead is visible in the builder portal immediately).
  // #721: lead reassignment rules (attribution close/open, invoice block).
  // (adminAuditStore is defined above, before the auth middleware.)
  const leadAssignmentService: LeadAssignmentService = createLeadAssignmentService({
    db: db.db,
    audit: adminAuditStore,
  });
  // #716: the Stripe customer re-syncs on a builder profile change. The
  // card service is built later (it needs the payment provider), so the
  // hook binds late.
  let syncStripeCustomer: ((builder: Builder) => Promise<void>) | null = null;
  const builderService: BuilderService = createBuilderService({
    db: db.db,
    audit: adminAuditStore,
    leadAssignment: leadAssignmentService,
    // #725: late-bound — the notifications service is built further down
    // (it needs the builder-leads "Needs you" feed). Never throws.
    onLeadAssigned: (args) => builderNotificationsService.notifyNewLead(args),
    onBillingProfileChanged: async (builder) => {
      await syncStripeCustomer?.(builder);
    },
  });
  const leadService: LeadService = createLeadService({
    store: leadStore,
    estimateStore,
    magicLinks: magicLinkStore,
    email: emailService,
    unsubscribe: unsubscribeService,
    appBaseUrl: config.email.appBaseUrl,
    dedupWindowDays: config.lead.dedupWindowDays,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
    minSubmitMs: config.lead.minSubmitMs,
    builderConfigs: builderConfigService,
    builders: builderService,
    // #725: late-bound (see builderService above).
    builderNotifier: {
      notifyNewLead: (args) => builderNotificationsService.notifyNewLead(args),
    },
    // #738: API-key leads need a consent attestation; quarantined for review.
    apiLeads: {
      leadConsentVersion: config.apiAccess.leadConsentVersion,
      quarantineLeads: config.apiAccess.quarantineLeads,
    },
  });
  const leadRoute: LeadRoute = createLeadRoute({ leads: leadService });
  const magicLinkService: MagicLinkService = createMagicLinkService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    estimates: estimateStore,
    email: emailService,
    unsubscribe: unsubscribeService,
    appBaseUrl: config.email.appBaseUrl,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
    magicLinkReissueCooldownMs: config.auth.magicLinkReissueCooldownMs,
    magicLinkMaxSendsPerHour: config.auth.magicLinkMaxSendsPerHour,
    reissueCooldown: createSharedCooldown({
      store: rateLimitStore,
      scope: 'magic-link:cooldown',
      cooldownMs: config.auth.magicLinkReissueCooldownMs,
    }),
    sendBudget: sharedLimiter('magic-link:send', {
      windowMs: MAGIC_LINK_SEND_BUDGET_WINDOW_MS,
      maxRequests: config.auth.magicLinkMaxSendsPerHour,
    }),
  });
  const magicLinkRoute: MagicLinkRoute = createMagicLinkRoute({
    magicLinks: magicLinkService,
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
    // #838: the cycle enqueues; the job-queue worker sends (with retries).
    queue: jobQueueService,
    nudgeDelayHours: config.reminders.unfinishedDelayHours,
    maxCandidatesPerRun: config.reminders.maxPerRun,
    // P0-class visibility guard: per-lead failures are swallowed into the
    // `skipped` count by design (batch survives); this sink makes a dead
    // provider visible. Sanitized: no tokens, emails, or keys.
    onLeadError: (error) =>
      console.error(
        `nudge: lead send failed (error=${sanitizeErrorMessage(error)})`,
      ),
  });
  // #703 — one post-report follow-up email (marketing consent only, flag
  // default off). Same stamp + no-retry rules as the nudge above.
  const followUpService: FollowUpService = createFollowUpService({
    enabled: config.followUpEmail.enabled,
    leads: leadStore,
    followUps: leadFollowUpStore,
    magicLinks: magicLinkStore,
    email: emailService,
    unsubscribe: unsubscribeService,
    appBaseUrl: config.email.appBaseUrl,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
    delayHours: config.followUpEmail.delayHours,
    // #838: the cycle enqueues; the job-queue worker sends (with retries).
    queue: jobQueueService,
    maxCandidatesPerRun: config.reminders.maxPerRun,
    onLeadError: (error) =>
      console.error(
        `follow-up: lead send failed (error=${sanitizeErrorMessage(error)})`,
      ),
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

  const sheetsSyncRunStore: SheetsSyncRunStore =
    createDrizzleSheetsSyncRunStore({ db: db.db });
  const sheetsSyncService: SheetsSyncService = createSheetsSyncService({
    leads: leadStore,
    estimates: estimateStore,
    sheets:
      options.sheetsClient ??
      (config.sheets.enabled
        ? createSheetsClientFromConfig(config)
        : createDisabledSheetsClient()),
    syncState:
      options.sheetsSyncStateStore ??
      createDrizzleSheetsSyncStateStore({ db: db.db }),
    runs: sheetsSyncRunStore,
    enabled: config.sheets.enabled,
    maxLeadsPerRun: config.sheets.maxLeadsPerRun,
    onSyncLagging: ({ consecutiveFailures, firstFailureAt }) =>
      opsAlertsService.notifyFailure('sheets_sync_failed', {
        consecutiveFailures,
        firstFailureAt,
      }),
    onSyncRecovered: () => opsAlertsService.notifyRecovered('sheets_sync_failed'),
  });
  // admin/05 — Sheets sync ops status + manual trigger. The status service
  // reads the durable run history (sheets_sync_runs); the manual trigger
  // runs one worker cycle inline and is audit-logged by the route.
  const sheetsSyncStatusService: SheetsSyncStatusService =
    createSheetsSyncStatusService({
      runs: sheetsSyncRunStore,
      leads: leadStore,
      sheets: sheetsSyncService,
      sheetsConfigured: config.sheets.enabled,
      lagAfterHours: config.sheets.lagAfterHours,
      runStaleAfterMin: config.sheets.runStaleAfterMin,
    });
  // admin/06 — daily Postgres backup freshness probe (`backup_missed`).
  // ARM is queried with the Function App's system-assigned managed identity
  // (no secrets). Undefined when disabled/unconfigured — the timer adapter
  // fails closed. Bicep enables it per environment and grants the identity
  // Reader on the resource group.
  const backupCheckService: BackupCheckService | undefined =
    config.backupCheck.enabled && config.backupCheck.subscriptionId
      ? createBackupCheckService({
          subscriptionId: config.backupCheck.subscriptionId,
          resourceGroup: config.backupCheck.resourceGroup,
          serverName: config.backupCheck.serverName,
          minRetentionDays: config.backupCheck.minRetentionDays,
          maxStaleHours: config.backupCheck.maxStaleHours,
          imdsTokenUrl: config.backupCheck.imdsTokenUrl,
          identityEndpoint: config.backupCheck.identityEndpoint,
          identityHeader: config.backupCheck.identityHeader,
          armBaseUrl: config.backupCheck.armBaseUrl,
        })
      : undefined;
  // auth/02 — admin session auth (Entra sign-in mints the sessions).
  // The session guard replaces the interim pre-shared-key guard; routes
  // are untouched (they depend on the AdminGuard interface).
  // #730: absolute + idle timeouts and activity tracking wrap the store, so
  // every session reader (guards, AuthContextService, view-as) enforces them.
  const adminSessionStore: AdminSessionStore = withSessionPolicy(
    options.adminSessionStore ?? createDrizzleAdminSessionStore({ db: db.db }),
    {
      absoluteTtlSeconds: config.auth.adminSessionTtlSeconds,
      idleTimeoutSeconds: config.auth.adminSessionIdleTimeoutSeconds,
      touchIntervalSeconds: config.auth.sessionActivityTouchIntervalSeconds,
    },
  );
  // (adminAuditStore is defined above with the builders-table setup.)
  const adminAuthService: AdminAuthService = createAdminAuthService({
    sessions: adminSessionStore,
    audit: adminAuditStore,
    // Entra end-session URL for logout (kills the IdP session too).
    entraSignIn: config.entraSignIn,
  });
  // auth/02 — Entra External ID sign-in. The token validator owns the
  // code exchange + id_token verification (no passwords in our database).
  // The callback service itself is wired below, after auth/01's user
  // stores exist — it consumes the typed Drizzle stores, not raw SQL.
  const entraTokenValidator: EntraTokenValidator = createEntraTokenValidator({
    ...config.entraSignIn,
  });
  const adminGuard: AdminGuard = createSessionAdminGuard({
    adminAuth: adminAuthService,
  });
  // auth/01 — Entra identity + invitations. Service only in this story;
  // the sign-in routes (auth/02) and user-management routes (auth/03)
  // consume userService from AppDeps. Stores are injectable for tests.
  const entraUserService: EntraUserService = createEntraUserService({
    tenantId: config.entra.tenantId,
    graphClientId: config.entra.graphClientId,
    graphClientSecret: config.entra.graphClientSecret,
    issuerDomain: config.entra.issuerDomain,
    loginBaseUrl: config.entra.loginBaseUrl,
    graphBaseUrl: config.entra.graphBaseUrl,
    configured: config.entra.configured,
  });
  const userStore: UserStore =
    options.userStore ?? createDrizzleUserStore({ db: db.db });
  const invitationStore: InvitationStore =
    options.invitationStore ?? createDrizzleInvitationStore({ db: db.db });
  const membershipStore: MembershipStore =
    options.membershipStore ?? createDrizzleMembershipStore({ db: db.db });
  // auth/05 hardening: created here (ahead of the builder-auth block) so
  // UserService can revoke builder sessions on disable — a staff-side
  // disable must kill portal sessions too, not just admin ones.
  const builderSessionStore: BuilderSessionStore = withSessionPolicy(
    options.builderSessionStore ??
      createDrizzleBuilderSessionStore({ db: db.db }),
    {
      absoluteTtlSeconds: config.auth.builderSessionTtlSeconds,
      idleTimeoutSeconds: config.auth.builderSessionIdleTimeoutSeconds,
      touchIntervalSeconds: config.auth.sessionActivityTouchIntervalSeconds,
    },
  );
  const userService: UserService = createUserService({
    users: userStore,
    invitations: invitationStore,
    memberships: membershipStore,
    email: emailService,
    appBaseUrl: config.email.appBaseUrl,
    invitationTtlSeconds: config.auth.invitationTtlSeconds,
    entra: entraUserService,
    audit: adminAuditStore,
    // auth/03: disabling a user revokes their admin sessions server-side.
    sessions: adminSessionStore,
    // auth/05 hardening: disabling a user revokes their builder-portal
    // sessions server-side too.
    builderSessions: builderSessionStore,
  });
  // auth/02 — callback. Resolves/links our user row through the typed
  // Drizzle stores above and mints the 7-day session in admin_sessions
  // bound to the user id.
  const entraCallbackService: EntraCallbackService = createEntraCallbackService({
    tokenValidator: entraTokenValidator,
    users: userStore,
    userService,
    sessions: adminSessionStore,
    audit: adminAuditStore,
    adminSessionTtlSeconds: config.auth.adminSessionTtlSeconds,
  });
  const entraCallbackRoute: AdminEntraCallbackRoute =
    createAdminEntraCallbackRoute({
      entraCallback: entraCallbackService,
      adminSessionTtlSeconds: config.auth.adminSessionTtlSeconds,
    });
  // admin/05 — Sheets sync ops status + manual trigger routes. Built after
  // the session guard: both routes are admin-gated, and the manual trigger
  // is audit-logged with the admin's email.
  const adminSheetsStatusRoute: AdminSheetsStatusRoute =
    createAdminSheetsStatusRoute({
      status: sheetsSyncStatusService,
      adminGuard,
    });
  // #838 — admin view of the job queue (failed jobs by default).
  const adminJobsRoute: AdminJobsRoute = createAdminJobsRoute({
    jobs: jobQueueService,
    adminGuard,
  });
  const adminSheetsSyncNowRoute: AdminSheetsSyncNowRoute =
    createAdminSheetsSyncNowRoute({
      status: sheetsSyncStatusService,
      audit: adminAuditStore,
      adminGuard,
    });
  // embed/09 — builder portal auth. The stores are injectable for tests.
  // (builderSessionStore is created above, ahead of UserService, so a
  // staff-side disable can revoke portal sessions too.)
  const builderAllowlistStore: BuilderAllowlistStore =
    options.builderAllowlistStore ??
    createDrizzleBuilderAllowlistStore({ db: db.db });
  const builderAuthService: BuilderAuthService = createBuilderAuthService({
    allowlist: builderAllowlistStore,
    sessions: builderSessionStore,
    // auth/04: resolves tenant_key → builder row at session creation.
    builders: builderService,
    audit: adminAuditStore,
    magicLinks: magicLinkStore,
    email: emailService,
    appBaseUrl: config.email.appBaseUrl,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
    magicLinkMaxSendsPerHour: config.auth.magicLinkMaxSendsPerHour,
    builderSessionTtlSeconds: config.auth.builderSessionTtlSeconds,
    // Entra end-session URL for logout (kills the IdP session too once
    // builder Entra lands in AUTH #74; ignored by the frontend until then).
    entraSignIn: config.entraSignIn,
    // P0-class visibility guard: same fire-and-forget send as admin auth —
    // a failed builder sign-in email must be loud, never swallowed.
    // Sanitized: no tokens, no emails, no keys.
    onEmailError: (error) =>
      console.error(
        `builder-auth: magic-link email send failed (error=${sanitizeErrorMessage(error)})`,
      ),
  });
  const builderGuard: BuilderGuard = createSessionBuilderGuard({
    builderAuth: builderAuthService,
  });
  // auth/04 — permission model + enforcement. The AuthContextService is the
  // single place that turns a session into effective permissions and the
  // server-side builder tenant; the PermissionGuard enforces it in routes.
  // Created BEFORE the builder auth route: GET /me resolves the
  // server-authoritative active-org role through the permission guard.
  const authContextService: AuthContextService = createAuthContextService({
    adminSessions: adminSessionStore,
    builderAuth: builderAuthService,
    users: userStore,
    memberships: membershipStore,
    builders: builderService,
    audit: adminAuditStore,
  });
  const permissionGuard: PermissionGuard = createPermissionGuard({
    authContext: authContextService,
    // #730: dangerous routes (registry `recentAuth`) need a recent sign-in.
    reauthWindowSeconds: config.auth.sessionReauthWindowSeconds,
  });
  const builderAuthRoute: BuilderAuthRoute = createBuilderAuthRoute({
    builderAuth: builderAuthService,
    permissionGuard,
    builderSessionTtlSeconds: config.auth.builderSessionTtlSeconds,
  });
  // auth/05 — builder Entra External ID sign-in (organization accounts).
  // Separate External ID app/user flow from admin (`config.builderEntraSignIn`).
  // Fail-closed while unprovisioned: the validator 503s until Karan
  // provisions the builder Entra app + user flow.
  const builderEntraTokenValidator: EntraTokenValidator =
    createEntraTokenValidator({
      ...config.builderEntraSignIn,
    });
  const builderEntraCallbackService: BuilderEntraCallbackService =
    createBuilderEntraCallbackService({
      tokenValidator: builderEntraTokenValidator,
      userService,
      users: userStore,
      builders: builderService,
      sessions: builderSessionStore,
      audit: adminAuditStore,
      builderSessionTtlSeconds: config.auth.builderSessionTtlSeconds,
    });
  const builderEntraCallbackRoute: BuilderEntraCallbackRoute =
    createBuilderEntraCallbackRoute({
      entraCallback: builderEntraCallbackService,
      builderSessionTtlSeconds: config.auth.builderSessionTtlSeconds,
      permissionGuard,
    });
  const builderUsersRoute: BuilderUsersRoute = createBuilderUsersRoute({
    userService,
    permissionGuard,
    authContext: authContextService,
    builderSessions: builderSessionStore,
  });
  // auth/05 — the builder Entra callback gets its own deliberately tight
  // limiter on a separate pipeline, same as the admin callback: 10
  // attempts per IP per 15 min. Entra owns credential brute-force; this
  // stops authorization-code replay abuse.
  const builderEntraCallbackRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.builderEntraSignIn.callbackRateLimit.windowMs,
    maxRequests: config.builderEntraSignIn.callbackRateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const builderEntraCallbackPipeline: RequestPipeline = createRequestPipeline({
    rateLimiter: builderEntraCallbackRateLimiter,
    csrf,
    logger: options.logger,
  });
  const viewAsService: ViewAsService = createViewAsService({
    sessions: adminSessionStore,
    users: userStore,
    memberships: membershipStore,
    builders: builderService,
    audit: adminAuditStore,
  });
  const adminViewAsRoute: AdminViewAsRoute = createAdminViewAsRoute({
    viewAs: viewAsService,
    permissionGuard,
    builders: builderService,
    userService,
  });
  // Builder-side view-as (2026-09-30, Karan): a builder_admin views the
  // portal as a regular team member of their own org. The builder session
  // store holds the view_as state (same token mechanism as admin view-as).
  const builderViewAsService: BuilderViewAsService = createBuilderViewAsService({
    sessions: builderSessionStore,
    users: userStore,
    memberships: membershipStore,
    audit: adminAuditStore,
  });
  const builderViewAsRoute: BuilderViewAsRoute = createBuilderViewAsRoute({
    viewAs: builderViewAsService,
    permissionGuard,
    userService,
  });
  // auth/03 — admin user management routes (thin adapters over
  // UserService; permission + org scoping inside the route).
  const adminUsersRoute: AdminUsersRoute = createAdminUsersRoute({
    userService,
    permissionGuard,
    builders: builderService,
  });
  // Admin ⌘K global search. The palette fires per keystroke, so it runs on
  // its own limiters. Primary is per client IP and runs BEFORE any token is
  // trusted — a session-token key alone is bypassable by rotating random
  // Bearer tokens (each a fresh bucket + a session lookup before the 401).
  // Secondary is per admin session (token hash — see
  // adminSessionRateLimitKey), skipped when no token is presented.
  const adminSearchIpRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.adminSearch.ipRateLimit.windowMs,
    maxRequests: config.adminSearch.ipRateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const adminSearchSessionRateLimiter: RateLimiter = createRateLimiter({
    windowMs: config.adminSearch.rateLimit.windowMs,
    maxRequests: config.adminSearch.rateLimit.maxRequests,
    maxTrackedKeys: config.rateLimit.maxTrackedKeys,
  });
  const adminSearchPipeline: RequestPipeline = createAdminSearchPipeline({
    ipLimiter: adminSearchIpRateLimiter,
    sessionLimiter: adminSearchSessionRateLimiter,
    csrf,
    logger: options.logger,
  });
  const adminSearchService: AdminSearchService = createAdminSearchService({
    store: options.adminSearchStore ?? createDrizzleAdminSearchStore({ db: db.db }),
    config: { maxHitsPerKind: config.adminSearch.maxHitsPerKind },
  });
  const adminSearchRoute: AdminSearchRoute = createAdminSearchRoute({
    search: adminSearchService,
    permissionGuard,
  });
  const adminAuthRoute: AdminAuthRoute = createAdminAuthRoute({
    adminAuth: adminAuthService,
    permissionGuard,
  });
  // builderLeadsService/builderLeadsRoute are constructed after the billing
  // block (billing/01): the service's won transition needs the billing hook,
  // which is built with the billing services below.
  // admin/02 — leads explorer. The store is injectable for tests.
  const adminLeadsStore: AdminLeadsStore =
    options.adminLeadsStore ?? createDrizzleAdminLeadsStore({ db: db.db });
  // #639: built before the privacy service, which exports/erases it.
  // #836: and before the admin/builder lead services, which show it.
  const callbackRequestStore: CallbackRequestStore =
    options.callbackRequestStore ??
    createDrizzleCallbackRequestStore({ db: db.db });
  const adminLeadsService: AdminLeadsService = createAdminLeadsService({
    store: adminLeadsStore,
    leadStore,
    estimateStore,
    audit: adminAuditStore,
    maxExportRows: 10000,
    reassignments: leadAssignmentService,
    callbacks: callbackRequestStore,
  });
  const adminLeadsRoute: AdminLeadsRoute = createAdminLeadsRoute({
    adminLeads: adminLeadsService,
    builders: builderService,
    adminGuard,
  });
  // Builders table admin (embed/02 admin-UI migration): CRUD + the route is
  // admin-gated inside, like every other admin route.
  const adminBuildersRoute: AdminBuildersRoute = createAdminBuildersRoute({
    builders: builderService,
    adminGuard,
  });
  // #888: builder partner disclosure. Public active list (cached) + admin
  // add/deactivate/reorder, audit-logged.
  const builderPartnersService: BuilderPartnersService = createBuilderPartnersService({
    store:
      options.builderPartnerStore ?? createDrizzleBuilderPartnerStore({ db: db.db }),
    audit: adminAuditStore,
    config: config.partners,
  });
  const partnersRoute: PartnersRoute = createPartnersRoute({
    partners: builderPartnersService,
  });
  const adminPartnersRoute: AdminPartnersRoute = createAdminPartnersRoute({
    partners: builderPartnersService,
    adminGuard,
  });
  // admin/03 — read-only estimate lookup. Reuses the session guard; no
  // mutation endpoints exist. The route is created after the narrative
  // service (below) so the admin narrative top-up can reuse it.
  const adminEstimatesService: AdminEstimatesService =
    createAdminEstimatesService({
      estimateStore,
      leadStore,
    });
  // admin/09 — calibration console. Read-only: the cost-data table the
  // engine serves is injected; no params are written here.
  const adminCalibrationService: AdminCalibrationService =
    createAdminCalibrationService({
      costData: PLACEHOLDER_COST_DATA,
    });
  const adminCalibrationRoute: AdminCalibrationRoute =
    createAdminCalibrationRoute({
      adminCalibration: adminCalibrationService,
      adminGuard,
    });
  const apiKeyService: ApiKeyService = createApiKeyService({
    keys: options.apiKeyStore ?? createDrizzleApiKeyStore({ db: db.db }),
    audit:
      options.apiKeyAuditStore ?? createDrizzleApiKeyAuditStore({ db: db.db }),
    authCacheTtlSeconds: config.apiKeyAuth.authCacheTtlSeconds,
    acceptedModes: config.apiKeyAuth.acceptedModes,
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
  // #520: built before the privacy service, which exports/erases it.
  const waitlistStore: WaitlistStore =
    options.waitlistStore ?? createDrizzleWaitlistStore({ db: db.db });
  const privacyService: PrivacyService = createPrivacyService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    estimates: estimateStore,
    privacy: privacyStore,
    waitlist: waitlistStore,
    callbacks: callbackRequestStore,
    blockers: createNoopBlockerChecker(),
    // #806: email the erase-confirmation link; reuses the magic-link
    // reissue cooldown setting and SHARES the per-address hourly send
    // budget ('magic-link:send') with the reissue path.
    email: emailService,
    appBaseUrl: config.email.appBaseUrl,
    confirmLinkTtlSeconds: config.auth.eraseConfirmLinkTtlSeconds,
    resendCooldownMs: config.auth.magicLinkReissueCooldownMs,
    maxSendsPerHour: config.auth.magicLinkMaxSendsPerHour,
    resendCooldown: createSharedCooldown({
      store: rateLimitStore,
      scope: 'privacy:erase-confirm:cooldown',
      cooldownMs: config.auth.magicLinkReissueCooldownMs,
    }),
    sendBudget: sharedLimiter('magic-link:send', {
      windowMs: MAGIC_LINK_SEND_BUDGET_WINDOW_MS,
      maxRequests: config.auth.magicLinkMaxSendsPerHour,
    }),
  });
  const privacyRoute: PrivacyRoute = createPrivacyRoute({
    privacy: privacyService,
  });
  // Narrative worker (consumer/06): provider selected by config.
  // 'log' is the dev/test default (refuses production);
  // 'openai-compatible' is the remote OpenAI-protocol LLM chain —
  // primary Gemini (Karan's pick) then fallback Groq, then the
  // static-guide tier in the narrative service. Fails closed until the
  // API key is in Key Vault; the Groq step stays dormant (skipped
  // gracefully) until its key is provisioned.
  // #759: the narrative LLM is only called by the monthly community-
  // narrative job (and admin regenerate) — never per estimate. The model
  // list is config-owned (COMMUNITY_NARRATIVE_MODELS, else NARRATIVE_MODELS).
  const narrativeProvider: NarrativeProvider =
    config.narrative.provider === 'openai-compatible'
      ? createOpenAiCompatibleNarrativeProvider({
          targets: [
            {
              label: 'gemini',
              apiKey: config.narrative.apiKey || undefined,
              models: config.communityNarratives.models,
              endpoint: config.narrative.endpoint,
            },
            {
              label: 'groq',
              apiKey: config.narrative.fallback.apiKey || undefined,
              models: config.narrative.fallback.models,
              endpoint: config.narrative.fallback.endpoint,
            },
          ],
          timeoutMs: config.narrative.timeoutMs,
        })
      : createLogNarrativeProvider();
  if (config.env === 'production' && config.narrative.provider === 'log') {
    throw new Error(
      'NARRATIVE_PROVIDER=log refuses production — configure the OpenAI-compatible provider.',
    );
  }
  // Monthly community narratives (#759): generation (timer + admin
  // regenerate) and the stored-narrative read used by reports.
  const communityNarrativeService: CommunityNarrativeService =
    createCommunityNarrativeService({
      store: createDrizzleCommunityNarrativeStore({ db: db.db }),
      provider: narrativeProvider,
      opsAlerts: opsAlertsService,
      config: config.communityNarratives,
    });
  const adminCommunityNarrativesRoute: AdminCommunityNarrativesRoute =
    createAdminCommunityNarrativesRoute({
      narratives: communityNarrativeService,
      audit: adminAuditStore,
      adminGuard,
    });
  // (Narrative service is created after propertyService below — it needs
  // the property lookup to resolve the community.)
  // Community stats route (neighbourhood/01): uses the service created above
  // for the NBH-02 estimate comparison.
  const communityStatsRoute: CommunityStatsRoute = createCommunityStatsRoute({
    communityStats: communityStatsService,
  });
  // City-data freshness (trust-strip/01): the landing trust strip's
  // "Refreshed <Month Year>" item, derived from the Socrata dataset
  // metadata. Fetch-only service (no db); 24h in-memory cache on successful
  // fetches; null on Socrata failure (route answers 200, never 500).
  const cityDataFreshnessService: CityDataFreshnessService =
    createCityDataFreshnessService(config.cityDataFreshness);
  const cityDataFreshnessRoute: CityDataFreshnessRoute =
    createCityDataFreshnessRoute({ freshness: cityDataFreshnessService });
  // Zoning rules catalogue (#687): the configured city's district → forms +
  // key rules table from @feasly/zoning. Pure data, verified values only.
  const zoningService: ZoningService = createZoningService({ config: config.zoning });
  // Community-stats monthly refresh (neighbourhood/05): recomputes
  // community_stats from fresh Socrata aggregates on a timer; ops can also
  // trigger it manually via POST /api/v1/admin/community-stats/refresh.
  // Two consecutive timer failures fire the community_stats_failed ops
  // alert (admin/06); recovery sends the all-clear and re-arms.
  // (adminAuditStore is defined above with the builders-table setup.)
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
      pruneMinRows: config.communityStatsRefresh.pruneMinRows,
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
  // #773: neighbourhood data. Providers (chosen by config) are handed ONLY
  // to the refresh service; the read service gets the store alone, so no
  // request path can reach an outside source. One ops alert after
  // NEIGHBOURHOOD_ALERT_AFTER_FAILURE_DAYS of failures; telemetry is one JSON
  // trace per provider run: `traces | where message startswith
  // '{"event":"neighbourhood_data.'`.
  // Shared City-data cache (#756) — also reused by neighbourhood reads (#777).
  const cityDataCacheStore: CityDataCacheStore =
    options.cityDataCacheStore ?? createDrizzleCityDataCacheStore({ db: db.db });
  const neighbourhoodDataStore: NeighbourhoodDataStore =
    options.neighbourhoodDataStore ?? createDrizzleNeighbourhoodDataStore({ db: db.db });
  const neighbourhoodRefreshService: NeighbourhoodRefreshService =
    createNeighbourhoodRefreshService({
      providers:
        options.neighbourhoodProviders ?? createNeighbourhoodProviders(config.neighbourhoodData),
      store: neighbourhoodDataStore,
      refreshDayOfMonth: config.neighbourhoodData.refreshDayOfMonth,
      alertAfterFailureDays: config.neighbourhoodData.alertAfterFailureDays,
      onFailing: ({ consecutiveFailures, firstFailureAt }) =>
        opsAlertsService.notifyFailure('neighbourhood_data_failed', {
          consecutiveFailures,
          firstFailureAt,
        }),
      onRecovered: () => opsAlertsService.notifyRecovered('neighbourhood_data_failed'),
      onEvent: (event) =>
        console.info(JSON.stringify({ ...event, event: `neighbourhood_data.${event.event}` })),
    });
  const neighbourhoodReadService: NeighbourhoodReadService = createNeighbourhoodReadService({
    store: neighbourhoodDataStore,
    lotRadiusM: config.neighbourhoodData.lotRadiusM,
    lotMetricsTtlMs: config.neighbourhoodData.lotMetricsTtlMs,
    amenityCategories: config.neighbourhoodData.amenityCategories,
    amenitySearchRadiusM: config.neighbourhoodData.amenitySearchRadiusM,
    amenityCountRadiiM: config.neighbourhoodData.amenityCountRadiiM,
    treeCoverThresholds: config.neighbourhoodData.treeCoverThresholds,
    communityCache: cityDataCacheStore,
    communityMetricsTtlMs: config.neighbourhoodData.communityMetricsTtlMs,
  });
  const communityLivingRoute: CommunityLivingRoute = createCommunityLivingRoute({
    neighbourhood: neighbourhoodReadService,
  });
  const adminNeighbourhoodDataRoute: AdminNeighbourhoodDataRoute =
    createAdminNeighbourhoodDataRoute({
      refresh: neighbourhoodRefreshService,
      audit: adminAuditStore,
      adminGuard,
    });
  // Builder embed config (embed/02): repo JSON inlined at build time wins,
  // Embed config route uses the builderConfigService created above.
  const embedConfigRoute: EmbedConfigRoute = createEmbedConfigRoute({
    builderConfig: builderConfigService,
  });
  // Embed relay-code exchange (embed/06): the iframe trades its one-time
  // `?feasly_rt=` code for a 12h in-memory session token. Single-use is
  // enforced atomically by the store; every attempt is audit-logged.
  const embedRelayStore: EmbedRelayStore = createDrizzleEmbedRelayStore({
    db: db.db,
  });
  const embedRelayService: EmbedRelayService = createEmbedRelayService({
    relayCodes: embedRelayStore,
    leads: leadStore,
    relayCodeTtlSeconds: config.embed.relayCodeTtlSeconds,
    sessionTtlSeconds: config.embed.sessionTtlSeconds,
    relayResendCooldownSeconds: config.embed.relayResendCooldownSeconds,
  });
  const embedSessionRoute: EmbedSessionRoute = createEmbedSessionRoute({
    relayService: embedRelayService,
  });
  // Embed relay-code re-issue (embed/06 AC3): the "session expired" state
  // re-issues a fresh code for an expired/used one (60s per-code cooldown).
  const embedRelayResendRoute: EmbedRelayResendRoute = createEmbedRelayResendRoute({
    relayService: embedRelayService,
  });
  // Property lookup (api-mcp/02): Socrata-backed address autocomplete +
  // property records. Public by design (City open data); the MCP server and
  // embeds call these instead of hitting Socrata directly.
  // #686: `zoning` is the CURRENT district from the city's land-use
  // provider (Calgary: Land Use Districts map), falling back to the roll.
  const landUseProvider = createLandUseProvider(config.landUse);
  // #756: every route reads City data through this one service — in-memory
  // tier, then the shared `city_data_cache` table, single-flight to the City.
  // Telemetry: one JSON trace per resolution / City call, queryable in App
  // Insights as `traces | where message startswith '{"event":"property_data.'`
  // (docs/ops/property-data-cache.md).
  const propertyService: PropertyService = createPropertyService(config.propertyData, {
    cache: cityDataCacheStore,
    onEvent: (event) =>
      console.info(JSON.stringify({ ...event, event: `property_data.${event.event}` })),
    ...(landUseProvider
      ? {
          landUse: {
            provider: landUseProvider,
            cacheTtlMs: config.landUse.cacheTtlMs,
            datasetId: config.landUse.datasetId,
            dbCacheTtlMs: config.landUse.dbCacheTtlMs,
          },
        }
      : {}),
  });
  const propertyRoute: PropertyRoute = createPropertyRoute({
    property: propertyService,
  });

  // #757: daily zoning source watch. Refreshes cached districts when the
  // City's Land Use Districts dataset changes, files one "catalogue may be
  // out of date" issue (GitHub token from Key Vault; none → log only), and
  // tells GET /zoning/districts whether the catalogue predates a change.
  const zoningWatchService: ZoningWatchService = createZoningWatchService({
    config: {
      ...config.zoning.watch,
      city: config.zoning.city,
      freshnessCacheTtlMs: config.zoning.freshnessCacheTtlMs,
    },
    zoning: zoningService,
    store: options.zoningWatchStore ?? createDrizzleZoningWatchStore({ db: db.db }),
    cityDataCache:
      'invalidateDataset' in cityDataCacheStore
        ? (cityDataCacheStore as CityDataCacheStore & CityDataCacheInvalidator)
        : { invalidateDataset: () => Promise.resolve(0) },
    ...(config.zoning.watch.githubToken
      ? {
          issues: createGitHubIssuesClient({
            repo: config.zoning.watch.githubRepo,
            token: config.zoning.watch.githubToken,
            apiBaseUrl: config.zoning.watch.githubApiUrl,
            httpTimeoutMs: config.zoning.watch.httpTimeoutMs,
          }),
        }
      : {}),
    logger: { info: (m) => console.info(m), warn: (m) => console.warn(m) },
  });
  const zoningRoute: ZoningRoute = createZoningRoute({
    zoning: zoningService,
    watch: zoningWatchService,
  });
  // phase-2 wiring: the five live-API endpoints the web app needs. Same
  // pinned cost data + draft gate as the estimate endpoint, so preview,
  // report and revision figures always agree with the canonical estimate.
  // (Placed after propertyService, which the report service depends on.)
  const reportSnapshotStore: ReportSnapshotStore =
    options.reportSnapshotStore ??
    createDrizzleReportSnapshotStore({ db: db.db });
  const partnerShareStore: PartnerShareStore =
    options.partnerShareStore ?? createDrizzlePartnerShareStore({ db: db.db });
  const previewService: PreviewService = createPreviewService({
    estimates: estimateService,
  });
  const previewRoute: PreviewRoute = createPreviewRoute({
    preview: previewService,
  });
  const reportService: ReportService = createReportService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    estimates: estimateStore,
    snapshots: reportSnapshotStore,
    properties: propertyService,
    costData: PLACEHOLDER_COST_DATA,
    allowDraftCostData: config.costEngine.allowDraftCostData,
    followUps: leadFollowUpStore,
  });
  const reportRoute: ReportRoute = createReportRoute({ reports: reportService });
  // Report narrative read path (consumer/06, #759): created here (after
  // propertyService) because it resolves the property's community, then
  // reads the stored community narrative — no LLM call per estimate.
  const narrativeService: NarrativeService = createNarrativeService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    estimates: estimateStore,
    properties: propertyService,
    communityNarratives: communityNarrativeService,
  });
  const narrativeRoute: NarrativeRoute = createNarrativeRoute({
    narrative: narrativeService,
  });
  // admin/03 route (created here — after the narrative service — so the
  // admin narrative top-up endpoint can reuse the generation pipeline).
  const adminEstimatesRoute: AdminEstimatesRoute = createAdminEstimatesRoute({
    adminEstimates: adminEstimatesService,
    narrative: narrativeService,
    adminGuard,
  });
  const callbackService: CallbackService = createCallbackService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    callbacks: callbackRequestStore,
    dateWindowDays: config.lead.callbackDateWindowDays,
  });
  const callbackRoute: CallbackRoute = createCallbackRoute({
    callbacks: callbackService,
  });
  const waitlistService: WaitlistService = createWaitlistService({
    waitlist: waitlistStore,
    consentVersion: config.waitlist.consentVersion,
  });
  const waitlistRoute: WaitlistRoute = createWaitlistRoute({
    waitlist: waitlistService,
  });
  const shareService: ShareService = createShareService({
    magicLinks: magicLinkStore,
    leads: leadStore,
    shares: partnerShareStore,
    email: emailService,
    appBaseUrl: config.email.appBaseUrl,
    magicLinkTtlSeconds: config.auth.magicLinkTtlSeconds,
    shareLinks: options.shareLinkStore ?? createDrizzleShareLinkStore({ db: db.db }),
    shareLinkTtlSeconds: config.shareLink.ttlSeconds,
    shareLinkMaxActive: config.shareLink.maxActive,
  });
  const shareRoute: ShareRoute = createShareRoute({ shares: shareService });
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
    sourceGroupLimit: config.analytics.funnelSourceGroupLimit,
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
    // #738: per-key daily/monthly quotas (invite-only free beta).
    quota: {
      daily: config.apiAccess.dailyQuota,
      monthly: config.apiAccess.monthlyQuota,
    },
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
  // #753: payment provider switch — the ONLY place a concrete payment
  // provider is chosen. `simulated` (dev default) is Stripe-shaped and
  // delivers signed events through the production webhook handler below;
  // `stripe` uses the SDK with the STRIPE_* Key Vault secrets.
  const simulatedPaymentProvider: SimulatedPaymentProvider | null =
    config.payments.provider === 'simulated'
      ? createSimulatedPaymentProvider({
          store: createDrizzleSimulatedPaymentStore(db.db),
          webhookSecret: config.payments.simulatedWebhookSecret,
          deliveryDelayMs: config.payments.simulatedWebhookDelayMs,
        })
      : null;
  const stripeService: StripeService = createStripeService({
    db: db.db,
    billing: config.billing,
    ...(simulatedPaymentProvider
      ? {
          client: simulatedPaymentProvider,
          webhookSecret: simulatedPaymentProvider.webhookSecret,
        }
      : {}),
  });
  const commissionService: CommissionService = createCommissionService({
    db: db.db,
    // #725: billing emails go to every opted-in active builder admin;
    // late-bound (see builderService above).
    billingRecipients: (tenantKey) =>
      builderNotificationsService.billingRecipients(tenantKey),
    billing: config.billing,
    attribution: attributionService,
    audit: billingAuditService,
    stripe: stripeService,
    email: emailService,
    opsInbox: config.email.opsInbox,
  });
  // billing/01 first charge path — the embed/04 no-op was replaced with the
  // real charge path here (per the placeholder's IRON RULE). commission +
  // lead_won + contract details → attribution → draft invoice → review.
  const embedBillingHookService: EmbedBillingHookService =
    createEmbedBillingHookService({
      billing: config.billing,
      attribution: attributionService,
      commission: commissionService,
      audit: billingAuditService,
    });
  // billing/01 API surface: POST /api/v1/billing/report-contract,
  // GET/POST /api/v1/billing/invoices/{id}[/dispute|/resolve].
  // Dispute console (billing/01 follow-on): the dispute service owns the
  // billing_disputes table; the facade records a dispute row whenever a
  // builder disputes an invoice.
  const disputeService: DisputeService = createDisputeService({
    db: db.db,
    audit: billingAuditService,
    commission: commissionService,
    stripe: stripeService,
    opsAlerts: opsAlertsService,
  });
  const billingService: BillingService = createBillingService({
    leadStore,
    billingHook: embedBillingHookService,
    commission: commissionService,
    builders: builderService,
    disputes: disputeService,
  });
  const invoiceSummaryStore: InvoiceSummaryStore = createInvoiceSummaryStore({
    db: db.db,
  });
  // billing/02 (BILL-02) — commission card-on-file: the setup-intent +
  // card-status endpoints. Model-gated inside the service. #716: card
  // lifecycle (single card, removal, expiry flag, customer details).
  const commissionCardService: CommissionCardService =
    createCommissionCardService({
      billing: config.billing,
      audit: billingAuditService,
      stripe: stripeService,
      invoiceSummaries: invoiceSummaryStore,
      builders: builderService,
    });
  syncStripeCustomer = (builder) =>
    commissionCardService.syncCustomerDetails(builder);
  // #661 — builder invoice PDF/receipt download.
  const invoicePdfService: InvoicePdfService = createInvoicePdfService({
    billing: billingService,
    commissionCard: commissionCardService,
    builders: builderService,
    // #714: supplier GST details on taxed invoices.
    ...(config.billing.tax ? { tax: config.billing.tax } : {}),
  });
  const billingRoute: BillingRoute = createBillingRoute({
    billing: billingService,
    commissionCard: commissionCardService,
    invoicePdf: invoicePdfService,
    builderGuard,
    adminGuard,
  });
  const adminDisputesRoute: AdminDisputesRoute = createAdminDisputesRoute({
    disputes: disputeService,
    adminGuard,
  });
  // embed/09 builder portal: won transitions run the billing charge path.
  // Portal scoping is by builder_id (builders table); the session's tenant
  // key resolves to the builder row.
  // #531 builder portal Money page header: one tenant-scoped read over the
  // invoice summaries + configured rate + card on file.
  const billingOverviewService: BillingOverviewService =
    createBillingOverviewService({
      billing: config.billing,
      invoiceSummaries: invoiceSummaryStore,
      commission: commissionService,
      commissionCard: commissionCardService,
    });
  const builderBillingOverviewRoute: BuilderBillingOverviewRoute =
    createBuilderBillingOverviewRoute({
      overview: billingOverviewService,
      builderGuard,
    });
  // billing/05 lead comments store — created here (ahead of the leads
  // service) so the lead list can carry per-lead notes counts/previews.
  const commentStore: CommentStore = createDrizzleCommentStore({ db: db.db });
  const builderLeadsService: BuilderLeadsService = createBuilderLeadsService({
    leadStore,
    audit: adminAuditStore,
    builders: builderService,
    billingHook: embedBillingHookService,
    invoiceSummaries: invoiceSummaryStore,
    commentSummaries: commentStore,
    callbackSummaries: callbackRequestStore,
    users: userStore,
    // Issue #530: "Mark won" → email the org's admins to record the contract.
    memberships: membershipStore,
    email: emailService,
    fallbackAdminInbox: config.email.opsAlertEmail,
    statusChanges: leadStatusChangeStore,
    reassignments: leadAssignmentService,
    needsYou: {
      staleAfterDays: config.lead.needsYouStaleDays,
      scanLimit: config.lead.needsYouScanLimit,
    },
  });
  const builderLeadsRoute: BuilderLeadsRoute = createBuilderLeadsRoute({
    builderLeads: builderLeadsService,
    builderGuard,
    permissionGuard,
  });
  // #725: builder notifications — new-lead email (send-once outbox), daily
  // "Needs you" digest, member preferences, billing-email recipients.
  const builderNotificationsService: BuilderNotificationsService =
    createBuilderNotificationsService({
      store: createDrizzleBuilderNotificationStore({ db: db.db }),
      email: emailService,
      needsYou: (tenantKey) => builderLeadsService.getNeedsYou(tenantKey),
      resolveCommunity: async (addressKey) =>
        (await propertyService.getProperty(addressKey)).community,
      config: config.builderNotifications,
      onError: (message) => console.error(message),
    });
  const builderNotificationsRoute: BuilderNotificationsRoute =
    createBuilderNotificationsRoute({
      notifications: builderNotificationsService,
      builderGuard,
    });
  // billing/05 lead comments: one service, two thin routes (builder/admin).
  const builderCommentsService: BuilderCommentsService =
    createBuilderCommentsService({
      comments: commentStore,
      builders: builderService,
      leadStore,
      users: userStore,
    });
  const builderCommentsRoute: BuilderCommentsRoute = createBuilderCommentsRoute({
    comments: builderCommentsService,
    builderGuard,
  });
  const adminCommentsRoute: AdminCommentsRoute = createAdminCommentsRoute({
    comments: builderCommentsService,
    adminGuard,
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
      // #719: bank chargebacks + Stripe-dashboard refunds.
      chargebacks: createChargebackService({
        db: db.db,
        audit: billingAuditService,
        email: emailService,
        opsInbox: config.email.opsInbox,
      }),
      commissionCard: commissionCardService,
      email: emailService,
      opsInbox: config.email.opsInbox,
    });
  const invoiceReviewerService: InvoiceReviewerService =
    createInvoiceReviewerService({
      billing: config.billing,
      commission: commissionService,
      audit: billingAuditService,
      stripe: stripeService,
    });
  const stripeWebhooksRoute: StripeWebhooksRoute = createStripeWebhooksRoute({
    billingWebhooks: billingWebhookService,
  });
  // Simulated events take the same path a real Stripe delivery does: the
  // webhook route → signature verification → idempotent dispatch.
  simulatedPaymentProvider?.connectWebhook((rawBody, signature) =>
    stripeWebhooksRoute.handle(rawBody, signature),
  );
  const simulatedPaymentsService: SimulatedPaymentsService =
    createSimulatedPaymentsService({
      provider: simulatedPaymentProvider,
      stripe: stripeService,
      commission: commissionService,
      audit: billingAuditService,
    });
  const simulatedPaymentsRoute: SimulatedPaymentsRoute =
    createSimulatedPaymentsRoute({
      simulatedPayments: simulatedPaymentsService,
      builderGuard,
      adminGuard,
    });
  // billing/03 follow-on: read-only dashboard rollup for
  // GET /api/v1/admin/billing (MRR, aging buckets, dunning, webhook health).
  const billingHealthService: BillingHealthService = createBillingHealthService(
    {
      db: db.db,
      billing: config.billing,
      stripe: stripeService,
    },
  );
  const adminBillingRoute: AdminBillingRoute = createAdminBillingRoute({
    billingHealth: billingHealthService,
    commission: commissionService,
    billing: billingService,
    adminGuard,
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
    csrf,
    logger: options.logger,
  });
  // MCP server (api-mcp/06): Streamable HTTP at POST /api/mcp/v1.
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
    previewService,
    previewRoute,
    reportSnapshotStore,
    reportService,
    reportRoute,
    callbackRequestStore,
    callbackService,
    callbackRoute,
    waitlistStore,
    waitlistService,
    waitlistRoute,
    partnerShareStore,
    shareService,
    shareRoute,
    analyticsStore,
    analyticsService,
    analyticsRoute,
    webTelemetryRateLimiter,
    webTelemetryPipeline,
    webTelemetryService,
    webTelemetryRoute,
    emailService,
    magicLinkStore,
    magicLinkService,
    magicLinkRoute,
    unsubscribeService,
    unsubscribeRoute,
    nudgeService,
    followUpService,
    sandboxPurgeService,
    sheetsSyncService,
    opsAlertsService,
    backupCheckService,
    apiKeyService,
    apiKeyRoute,
    adminAuthService,
    adminAuthRoute,
    entraCallbackRateLimiter,
    entraCallbackPipeline,
    entraTokenValidator,
    entraCallbackService,
    entraCallbackRoute,
    adminGuard,
    authContextService,
    permissionGuard,
    viewAsService,
    adminViewAsRoute,
    builderViewAsRoute,
    adminUsersRoute,
    adminSearchIpRateLimiter,
    adminSearchSessionRateLimiter,
    adminSearchPipeline,
    adminSearchService,
    adminSearchRoute,
    userService,
    userStore,
    invitationStore,
    membershipStore,
    builderAuthService,
    builderAuthRoute,
    builderGuard,
    builderEntraCallbackService,
    builderEntraCallbackRoute,
    builderEntraCallbackPipeline,
    builderUsersRoute,
    builderLeadsService,
    builderLeadsRoute,
    commentStore,
    builderCommentsService,
    builderCommentsRoute,
    adminCommentsRoute,
    builderAllowlistStore,
    builderSessionStore,
    builderService,
    adminBuildersRoute,
    builderPartnersService,
    partnersRoute,
    adminPartnersRoute,
    adminLeadsService,
    adminLeadsRoute,
    adminLeadsStore,
    adminCalibrationService,
    adminCalibrationRoute,
    adminSheetsStatusRoute,
    adminSheetsSyncNowRoute,
    adminJobsRoute,
    jobQueueService,
    adminEstimatesService,
    adminEstimatesRoute,
    privacyStore,
    privacyService,
    privacyRoute,
    narrativeService,
    narrativeRoute,
    communityNarrativeService,
    adminCommunityNarrativesRoute,
    communityStatsService,
    communityStatsRoute,
    cityDataFreshnessService,
    cityDataFreshnessRoute,
    zoningService,
    zoningRoute,
    zoningWatchService,
    communityStatsRefreshService,
    communityStatsRefreshRoute,
    neighbourhoodRefreshService,
    neighbourhoodReadService,
    adminNeighbourhoodDataRoute,
    communityLivingRoute,
    adminAuditStore,
    builderConfigService,
    embedConfigRoute,
    embedRelayStore,
    embedRelayService,
    embedSessionRoute,
    embedRelayResendRoute,
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
    billingService,
    billingRoute,
    billingOverviewService,
    builderBillingOverviewRoute,
    builderNotificationsService,
    builderNotificationsRoute,
    disputeService,
    adminDisputesRoute,
    adminBillingRoute,
    stripeService,
    commissionService,
    flatPlanService,
    commissionCardService,
    billingWebhookService,
    invoiceReviewerService,
    stripeWebhooksRoute,
    simulatedPaymentsService,
    simulatedPaymentsRoute,
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
        sendTimeoutMs: config.email.acsSendTimeoutMs,
      });
    case 'log':
    default:
      return createLogEmailProvider({
        env: config.env,
        logLinks: config.email.logLinks,
      });
  }
}
