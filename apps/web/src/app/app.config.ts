import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideStore, type NgxsModuleOptions } from '@ngxs/store';
import { SESSION_STORAGE_ENGINE, withNgxsStoragePlugin } from '@ngxs/storage-plugin';
import { provideApi } from './core/api/api.service';
import { providePropertyData } from './core/api/property-data.service';
import { GlobalErrorHandler, connectivityInterceptor } from './core/errors';
import { credentialsInterceptor } from './core/api/credentials.interceptor';
import { ConfigService } from './core/config/config.service';
import { WebTelemetryService } from './core/telemetry/web-telemetry.service';
import { PartnersState } from './core/partners/partners.state';
import { EmbedState } from './features/embed/embed.state';
import { ComparisonState } from './features/compare/comparison.state';
import { ReportState, serializeReportState } from './features/report/report.state';
import type { ReportStateModel } from './features/report/report.state';
import { LeadState } from './features/wizard/lead.state';
import { WizardState } from './features/wizard/wizard.state';
import { ConsentState } from './features/consent/consent.state';
import { CampaignSourceState } from './features/consent/campaign-source.state';
import { AdminAuthState } from './features/admin/admin-auth.state';
import { BuilderState, EMPTY_SUMMARY } from './features/builder/builder.state';
import { BuilderBillingState } from './features/builder/builder-billing.state';
import { DueInvoiceBannersState } from './features/builder/due-invoice-banners.state';
import { BuilderReportContractState } from './features/builder/builder-report-contract.state';
import { BuilderTeamState } from './features/builder/builder-team.state';
import { CommunityProfileState } from './features/communities/community-profile.state';
import { AnalyticsTrackerService } from './features/consent/analytics-tracker.service';
import { RouteFocusService } from './core/a11y/route-focus.service';
import { routes } from './app.routes';

/**
 * Root NGXS options. `strictContentSecurityPolicy` makes NGXS read state
 * paths with a plain property walk instead of compiling getters with
 * `new Function(...)`, so the SWA CSP can drop `'unsafe-eval'` from
 * script-src (#797, #731 F-5). Removing this flag re-breaks every page
 * under the CSP (EvalError) — check-security-headers.mjs forbids
 * `'unsafe-eval'`, and app.config.spec.ts pins this option.
 */
export const NGXS_STORE_OPTIONS: NgxsModuleOptions = {
  compatibility: { strictContentSecurityPolicy: true },
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Uncaught client failures route to the branded /error page (HRD-02) —
    // never a blank screen. The handler logs the raw error to the console
    // only; the page renders static copy (no stack traces, no PII).
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideRouter(routes),
    // The connectivity interceptor (HRD-02) re-verifies reachability via the
    // health probe whenever a request fails at the network layer. The
    // credentials interceptor (ADM-10) attaches withCredentials to API-base
    // requests plus `Authorization: Bearer <token>` on admin/builder paths —
    // the cross-origin session cookie never sticks on modern browsers, so
    // the bearer token is the primary session credential.
    provideHttpClient(
      withFetch(),
      withInterceptors([credentialsInterceptor, connectivityInterceptor]),
    ),
    // Load /assets/config/app-config.json before first render (FE0-002).
    // Never rejects: ConfigService falls back to compiled defaults.
    // #830: real-user monitoring starts once config is loaded (it reads the
    // sample rate + API base); browser-only, sampled, never throws.
    provideAppInitializer(() => {
      const telemetry = inject(WebTelemetryService);
      return inject(ConfigService)
        .load()
        .then(() => telemetry.start());
    }),
    // First-party analytics route tracking (consumer/01 call-site handoff):
    // maps completed funnel navigations to analytics events. Consent-gated
    // inside AnalyticsService — pre-consent navigations emit nothing.
    provideAppInitializer(() => inject(AnalyticsTrackerService).start()),
    // #832: move focus to the new page's <main> after client-side navigation
    // so screen-reader users hear the new step (WCAG 2.4.3 / 4.1.3).
    provideAppInitializer(() => inject(RouteFocusService).start()),
    // Property data source from config (FE1-002): live City of Calgary API
    // by default, mock fixtures or our backend on request. Must come before
    // provideApi() — both ApiService implementations delegate to it.
    providePropertyData(),
    // Mock vs real backend from config (FE0-003). Flip `api.useMockApi` only.
    provideApi(),
    // Wizard + report + lead + embed state in NGXS (FE1-001, M1, FE-004,
    // EMB-01). Wizard/report/lead persist to localStorage (notes below); the
    // embed config is session-scoped (re-fetched from ?key= every load) so a
    // stale builder config can never leak across tenants — EmbedState stays
    // out of the storage-plugin keys. The storage plugin is SSR-safe.
    // The lead receipt (leadId, email, magicLinkSent, expiresInDays) persists
    // so a reload mid-flow doesn't loop the user back to an empty gate —
    // the report unlocks immediately from the submitted lead (Karan
    // directive 2026-09-27). The lead's NAME never enters the store (it
    // stays in the gate form), and there is no bearer credential here — see
    // the report token note below.
    // Security: the report token is a bearer credential — it lives in memory
    // only and is stripped before persistence. The snapshot (the user's own
    // figures plus the AI narrative) persists, so the report still renders
    // the SAME report after a refresh or a magic-link return — a rebuild
    // from the public estimate endpoint would drop the narrative, which
    // needs the memory-only token to re-fetch (ai-summary-persistence);
    // token-authenticated actions (tier/sqft re-run, share, callback) surface
    // an honest inline error when the token is missing (e.g. after a reload),
    // because the magic-link email is the only re-verification path.
    // AdminLeadsState, AdminDisputesState, CalibrationState, and
    // SheetsSyncState are memory-only on purpose: admin/builder DATA is
    // sensitive and must not persist in localStorage — it refetches on
    // mount. (All kept out of the storage plugin's keys below.)
    // All four are NOT in the root store: they lazy-load at the `/admin`
    // route via lazyProvider (app.routes.ts) so they stay out of the
    // initial bundle (740kB lighthouse budget). The AUTH slices are
    // different: AdminAuthState
    // holds only the session token + the admin's own email, and BuilderState
    // persists ONLY its sessionToken (identity + homeowner-PII leads are
    // stripped in beforeSerialize below). The tokens must persist — the
    // cross-origin session cookie never sticks on modern browsers, so
    // without persistence every reload would bounce to the login page.
    // Security note: a bearer token in localStorage is XSS-stealable where
    // an httpOnly cookie was not — the standard, accepted tradeoff for
    // cross-origin SPAs (the cookie simply does not work cross-origin).
    provideStore(
      // ApiKeysState is NOT here: it is lazy-loaded at the `admin/api-keys` route
      // via lazyProvider (api-mcp/02) so the admin state stays out of the initial bundle.
      [
        WizardState,
        ReportState,
        LeadState,
        EmbedState,
        ConsentState,
        // #815: session-scoped campaign attribution (utm / click-id type /
        // referrer host) — persisted to sessionStorage below.
        CampaignSourceState,
        ComparisonState,
        // Admin data states are memory-only (never persisted) and NOT in
        // the root store — they lazy-load at the `/admin` route via
        // lazyProvider (app.routes.ts) so they stay out of the initial
        // bundle: AdminLeadsState, AdminDisputesState, CalibrationState,
        // SheetsSyncState.
        BuilderState,
        BuilderBillingState,
        // BuilderInvoicesState is NOT here: it lazy-loads at the
        // `builder/invoices` route via lazyProvider (app.routes.ts) so the
        // invoices state — and the builder copy it reads — stays out of the
        // initial bundle.
        BuilderReportContractState,
        BuilderTeamState,
        AdminAuthState,
        // CommunityProfileState is transient (never persisted): the property
        // context is navigation-scoped, and a refresh behaves like a direct
        // URL visit (community average only).
        CommunityProfileState,
        // PartnersState (#918) is memory-only: the partner list is read once
        // per session from GET /api/v1/partners and never persisted.
        PartnersState,
      ],
      NGXS_STORE_OPTIONS,
      withNgxsStoragePlugin({
        // CalibrationState is deliberately EXCLUDED from persistence:
        // calibration data is admin-internal and must never sit in
        // localStorage. It is memory-only, re-fetched on each visit.
        keys: [
          WizardState,
          ReportState,
          LeadState,
          EmbedState,
          ConsentState,
          // #815: first-touch attribution lives for the tab session only.
          { key: CampaignSourceState, engine: SESSION_STORAGE_ENGINE },
          ComparisonState,
          AdminAuthState,
          BuilderState,
          // Due-invoice banner UI state (dismissed/open/collapsed): invoice
          // ids are opaque UUIDs (no PII) and dismissal must survive a
          // reload (Karan). The state itself lazy-loads at the dashboard
          // route; the storage plugin rehydrates it on the lazy
          // UpdateState. Stale ids are pruned on each actionable load.
          DueInvoiceBannersState,
        ],
        beforeSerialize: (obj, key) =>
          // The report token, partner view, pre-gate preview, and transient
          // load state never reach localStorage — see serializeReportState
          // (ai-summary-persistence): the snapshot itself persists, the
          // rest is session-scoped or reset. `savedVersion` (the revision
          // counter) deliberately persists alongside the snapshot so the
          // rebuilt report keeps its honest version label.
          key === 'report'
            ? serializeReportState(obj as ReportStateModel)
            : key === 'comparison'
              ? { ...obj, leadId: null }
              : // The relay code is a single-use secret: memory-only, never
                // persisted. Transient resend UI state is reset too — the
                // shell re-boots and re-posts the stashed code on reload.
                key === 'embed'
                ? { ...obj, relayCode: null, resending: false, resendError: null }
                : // BuilderState persists ONLY the session token: the session
                  // identity and the lead list (homeowner PII) are stripped so
                  // they can never sit in localStorage. The shape is kept
                  // complete so rehydration can't break selectors/templates.
                  key === 'builder'
                  ? {
                      sessionToken: obj.sessionToken ?? null,
                      session: null,
                      authStatus: 'unknown',
                      sessionExpired: false,
                      leads: [],
                      summary: { ...EMPTY_SUMMARY },
                      reassigned: [],
                      leadsStatus: 'idle',
                      updatingLeadId: null,
                      updateError: null,
                    }
                  : // AdminAuthState persists the session token + identity so the
                    // session survives a reload, but the transient Entra
                    // error classification is reset — a reload must never
                    // repaint a stale failure (auth/02).
                    key === 'adminAuth'
                    ? {
                        ...obj,
                        lastEntraError: null,
                        // auth/04: view-as is session-derived and re-probed
                        // on boot — never repaint a stale banner.
                        viewAs: null,
                        viewAsDisplayName: null,
                        viewAsRealEmail: null,
                      }
                    : obj,
      }),
    ),
  ],
};
