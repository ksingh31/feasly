import { inject } from '@angular/core';
import type { PillarGuideCopy } from '@app/core/config/app-config';
import { ConfigService } from '@app/core/config/config.service';
import { mergeLazyCopy } from '@app/core/config/lazy-copy';
import { DEFAULT_PILLAR_GUIDE_COPY } from './pillar-guide-copy.defaults';

/**
 * Pillar cost-guide copy (`copy.marketing.pillarGuide`), also read by the
 * help page.
 *
 * #980: the compiled defaults live in this lazy chunk, not in
 * DEFAULT_APP_CONFIG, so the initial bundle doesn't carry them. Import this
 * only from lazy files — importing it from an eager file (app.ts,
 * app.config.ts, app.routes.ts, a root state or guard) would drag the copy
 * back into the initial bundle. Deploy overrides at
 * `copy.marketing.pillarGuide` in app-config.json still apply. Call in an
 * injection context.
 */
export function injectPillarGuideCopy(): PillarGuideCopy {
  return mergeLazyCopy(inject(ConfigService), DEFAULT_PILLAR_GUIDE_COPY, ['marketing', 'pillarGuide']);
}
