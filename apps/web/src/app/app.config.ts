import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideApi } from './core/api/api.service';
import { ConfigService } from './core/config/config.service';
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
  ],
};
