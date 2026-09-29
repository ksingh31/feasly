import { InjectionToken, type Provider } from '@angular/core';
import type { BuilderCopy } from '../../core/config/app-config';
import { ConfigService } from '../../core/config/config.service';
import { deepMerge, type DeepPartial } from '../../core/config/deep-merge';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';

/**
 * User-facing builder-portal copy.
 *
 * Provided at the builder routes (shell + login/callback/org-picker) via
 * {@link provideBuilderCopy} — NOT at root — so the initial bundle doesn't
 * carry the builder copy. Imported only from lazy builder files; importing
 * this module from an eager file (app.routes.ts, app.config.ts) would drag
 * the copy back into the initial bundle.
 */
export const BUILDER_COPY = new InjectionToken<BuilderCopy>('Feasly builder portal copy');

/**
 * Provides {@link BUILDER_COPY}: the compiled {@link DEFAULT_BUILDER_COPY}
 * deep-merged with any deploy-time `copy.builder` overrides from
 * `/assets/config/app-config.json` (retained by ConfigService, so the
 * overrides survive without the defaults living in the initial bundle).
 * Unknown override keys are dropped by deepMerge, matching ConfigService.
 */
export function provideBuilderCopy(): Provider {
  return {
    provide: BUILDER_COPY,
    useFactory: (config: ConfigService) =>
      deepMerge<BuilderCopy>(
        structuredClone(DEFAULT_BUILDER_COPY),
        (config.getServedBuilderCopy() ?? {}) as DeepPartial<BuilderCopy>,
      ),
    deps: [ConfigService],
  };
}
