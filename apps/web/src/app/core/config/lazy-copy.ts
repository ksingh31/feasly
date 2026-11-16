import type { ConfigService } from './config.service';
import { deepMerge, type DeepPartial } from './deep-merge';

/**
 * Lazy copy sections (#980): compiled copy defaults that live in a lazy
 * feature chunk instead of DEFAULT_APP_CONFIG, so the initial bundle doesn't
 * carry them (Lighthouse script budget).
 *
 * Returns a fresh copy of `defaults` deep-merged with any deploy-time
 * overrides served at `copy.<path>` in app-config.json, the same merge
 * ConfigService applies to the root config (unknown keys are dropped).
 */
export function mergeLazyCopy<T extends object>(
  config: ConfigService,
  defaults: T,
  path: readonly string[],
): T {
  return deepMerge<T>(
    structuredClone(defaults),
    (config.getServedCopy(path) ?? {}) as DeepPartial<T>,
  );
}
