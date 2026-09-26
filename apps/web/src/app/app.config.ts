import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { withNgxsStoragePlugin } from '@ngxs/storage-plugin';
import { provideApi } from './core/api/api.service';
import { providePropertyData } from './core/api/property-data.service';
import { GlobalErrorHandler, connectivityInterceptor } from './core/errors';
import { credentialsInterceptor } from './core/api/credentials.interceptor';
import { ConfigService } from './core/config/config.service';
import { EmbedState } from './features/embed';
import { ComparisonState } from './features/compare';
import { ReportState } from './features/report';
import { LeadState, WizardState } from './features/wizard';
import { ConsentState } from './features/consent';
import { AdminLeadsState } from './features/admin/admin-leads.state';
import { AnalyticsTrackerService } from './features/consent';
import { routes } from './app.routes';

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
    // requests so the admin session cookie flows cross-origin.
    provideHttpClient(withFetch(), withInterceptors([credentialsInterceptor, connectivityInterceptor])),
    // Load /assets/config/app-config.json before first render (FE0-002).
    // Never rejects: ConfigService falls back to compiled defaults.
    provideAppInitializer(() => inject(ConfigService).load()),
    // First-party analytics route tracking (consumer/01 call-site handoff):
    // maps completed funnel navigations to analytics events. Consent-gated
    // inside AnalyticsService — pre-consent navigations emit nothing.
    provideAppInitializer(() => inject(AnalyticsTrackerService).start()),
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
    // email is needed anyway for the pending "check your email" state. The
    // lead's NAME never enters the store (it stays in the gate form), and
    // there is no bearer credential here — see the report token note below.
    // Security: the report token is a bearer credential — it lives in memory
    // only and is stripped before persistence. The snapshot (the user's own
    // figures) persists, so the report still renders after a refresh;
    // token-authenticated actions (tier/sqft re-run, share, callback) surface
    // an honest inline error when the token is missing (e.g. after a reload),
    // because the magic-link email is the only re-verification path.
    // AdminLeadsState is memory-only on purpose: admin lead data is
    // sensitive and must not persist in localStorage — it refetches on mount.
    // (Kept out of the storage plugin's keys below.)
    provideStore(
      [WizardState, ReportState, LeadState, EmbedState, ConsentState, ComparisonState, AdminLeadsState],
      withNgxsStoragePlugin({
        keys: [WizardState, ReportState, LeadState, EmbedState, ConsentState, ComparisonState],
        beforeSerialize: (obj, key) =>
          // The report token and the comparison unlock are session-scoped:
          // strip them so a refresh re-gates instead of silently unlocking.
          key === 'report'
            ? { ...obj, reportToken: null }
            : key === 'comparison'
              ? { ...obj, leadId: null }
              : obj,
      }),
    ),
  ],
};
