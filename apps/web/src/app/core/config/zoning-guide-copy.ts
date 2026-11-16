import { inject } from '@angular/core';
import type { ZoningGuideCopy } from './app-config';
import { ConfigService } from './config.service';
import { mergeLazyCopy } from './lazy-copy';
import { DEFAULT_ZONING_GUIDE_COPY } from './zoning-guide-copy.defaults';

/**
 * Zoning-guide copy (`copy.marketing.zoningGuide`): the zoning guide page,
 * the help page and the preview page's zone table. Lives in core because
 * more than one feature reads it.
 *
 * #980: the compiled defaults live in this module, not in
 * DEFAULT_APP_CONFIG, so they ship only with the lazy chunks that import it.
 * Import this only from lazy files — importing it from an eager file
 * (app.ts, app.config.ts, app.routes.ts, a root state or guard) would drag
 * the copy back into the initial bundle. Deploy overrides at
 * `copy.marketing.zoningGuide` in app-config.json still apply. Call in an
 * injection context.
 */
export function injectZoningGuideCopy(): ZoningGuideCopy {
  return mergeLazyCopy(inject(ConfigService), DEFAULT_ZONING_GUIDE_COPY, ['marketing', 'zoningGuide']);
}
