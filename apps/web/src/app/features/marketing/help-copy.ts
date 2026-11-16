import { InjectionToken, type Provider } from '@angular/core';
import type { HelpCopy } from '../../core/config/app-config';
import { ConfigService } from '../../core/config/config.service';
import { deepMerge, type DeepPartial } from '../../core/config/deep-merge';
import { DEFAULT_HELP_COPY } from './help-copy.defaults';

/**
 * `/help` page copy (#834).
 *
 * Provided by HelpPageComponent via {@link provideHelpCopy}, not at root, so
 * the copy ships in the lazy help chunk instead of the initial bundle
 * (Lighthouse script-size budget). Import this only from lazy help files;
 * importing it from an eager file would pull the copy back into the initial
 * bundle.
 */
export const HELP_COPY = new InjectionToken<HelpCopy>('Feasly help page copy');

/**
 * Provides {@link HELP_COPY}: the compiled {@link DEFAULT_HELP_COPY}
 * deep-merged with any deploy-time `copy.marketing.help` overrides from
 * `/assets/config/app-config.json` (kept by ConfigService). Unknown override
 * keys are dropped by deepMerge, the same as in ConfigService.
 */
export function provideHelpCopy(): Provider {
  return {
    provide: HELP_COPY,
    useFactory: (config: ConfigService) =>
      deepMerge<HelpCopy>(
        structuredClone(DEFAULT_HELP_COPY),
        (config.getServedHelpCopy() ?? {}) as DeepPartial<HelpCopy>,
      ),
    deps: [ConfigService],
  };
}
