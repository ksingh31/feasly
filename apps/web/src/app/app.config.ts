import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { withNgxsStoragePlugin } from '@ngxs/storage-plugin';
import { provideApi } from './core/api/api.service';
import { providePropertyData } from './core/api/property-data.service';
import { ConfigService } from './core/config/config.service';
import { ReportState } from './features/report';
import { LeadState, WizardState } from './features/wizard';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    // Load /assets/config/app-config.json before first render (FE0-002).
    // Never rejects: ConfigService falls back to compiled defaults.
    provideAppInitializer(() => inject(ConfigService).load()),
    // Property data source from config (FE1-002): live City of Calgary API
    // by default, mock fixtures or our backend on request. Must come before
    // provideApi() — both ApiService implementations delegate to it.
    providePropertyData(),
    // Mock vs real backend from config (FE0-003). Flip `api.useMockApi` only.
    provideApi(),
    // Wizard + report state in NGXS, persisted to localStorage (FE1-001, M1).
    // The storage plugin is SSR-safe (no-ops on the server); nothing sensitive
    // is stored pre-gate — email/name live in the in-memory-only LeadState
    // (FE-004), which is deliberately NOT in the storage plugin's keys.
    // Security: the report token is a bearer credential — it lives in memory
    // only and is stripped before persistence. The snapshot (the user's own
    // figures) persists, so the report still renders after a refresh;
    // token-authenticated actions (tier/sqft re-run, share, callback) dispatch
    // UnlockReport to re-establish the token if it is missing.
    provideStore(
      [WizardState, ReportState, LeadState],
      withNgxsStoragePlugin({
        keys: [WizardState, ReportState],
        beforeSerialize: (obj, key) => (key === 'report' ? { ...obj, reportToken: null } : obj),
      }),
    ),
  ],
};
