import { InjectionToken } from '@angular/core';

/**
 * URL of the deploy-time config JSON. Served as a static asset; never bundled.
 *
 * An injection token — not a module-level const — so tests and future
 * white-label builds can point the app at a different config file without
 * touching code. The factory value is the single intentional bootstrap
 * literal (see FE0-002); everything else tunable lives in the JSON itself.
 */
export const CONFIG_URL = new InjectionToken<string>('feasly.config-url', {
  providedIn: 'root',
  factory: () => '/assets/config/app-config.json',
});
