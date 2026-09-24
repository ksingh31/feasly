import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AppConfig } from './app-config';
import { DEFAULT_APP_CONFIG } from './app-config.defaults';
import { CONFIG_URL } from './config-url.token';
import { deepMerge, isPlainObject } from './deep-merge';
import type { DeepPartial } from './deep-merge';

/** Where the deploy-time config lives. Served as a static asset; never bundled. */

/**
 * Single source of every tunable value in the app.
 *
 * Loaded once via APP_INITIALIZER before first render: the JSON file is
 * deep-merged over {@link DEFAULT_APP_CONFIG}. Defined behaviors:
 * - JSON missing a key → compiled default applies (app keeps working).
 * - JSON malformed / request fails / body isn't a JSON object → compiled
 *   defaults apply + console.warn (a bad deploy can never corrupt the typed
 *   config — this is the trust boundary for deploy-controlled data).
 * - JSON contains unknown keys → ignored (config stays exactly AppConfig).
 *
 * Components and services inject this and read sections — never literals.
 */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly http = inject(HttpClient);
  private readonly configUrl = inject(CONFIG_URL);
  private readonly _config = signal<AppConfig>(structuredClone(DEFAULT_APP_CONFIG));

  /** Reactive config snapshot. Re-reads if the config is ever reloaded. */
  readonly config = this._config.asReadonly();

  /** Typed section accessor, e.g. `config.get('wizard').sqftDefault`. */
  get<K extends keyof AppConfig>(section: K): AppConfig[K] {
    return this._config()[section];
  }

  /** Fetch + merge. Never rejects: failure falls back to compiled defaults. */
  async load(): Promise<void> {
    try {
      const json = await firstValueFrom(this.http.get<Partial<AppConfig>>(this.configUrl));
      if (!isPlainObject(json)) {
        console.warn('[ConfigService] non-object config; defaults used.', this.configUrl);
        return;
      }
      // Shape beyond "plain object" is deploy-trusted: deepMerge drops unknown
      // keys, and every known key keeps its compiled default unless overridden.
      this._config.set(
        deepMerge<AppConfig>(structuredClone(DEFAULT_APP_CONFIG), json as DeepPartial<AppConfig>),
      );
    } catch (error) {
      console.warn('[ConfigService] using compiled defaults.', error);
    }
  }
}
