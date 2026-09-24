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
import { ConfigService } from './core/config/config.service';
import { WizardState } from './features/wizard';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    // Load /assets/config/app-config.json before first render (FE0-002).
    // Never rejects: ConfigService falls back to compiled defaults.
    provideAppInitializer(() => inject(ConfigService).load()),
    // Mock vs real backend from config (FE0-003). Flip `api.useMockApi` only.
    provideApi(),
    // Wizard state in NGXS, persisted to localStorage (FE1-001). The storage
    // plugin is SSR-safe (no-ops on the server); nothing sensitive is stored
    // pre-gate — email/name live in the future lead state, not here.
    provideStore([WizardState], withNgxsStoragePlugin({ keys: [WizardState] })),
  ],
};
