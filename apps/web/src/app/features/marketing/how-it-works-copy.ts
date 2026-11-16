import { inject } from '@angular/core';
import type { HowItWorksCopy } from '@app/core/config/app-config';
import { ConfigService } from '@app/core/config/config.service';
import { mergeLazyCopy } from '@app/core/config/lazy-copy';
import { DEFAULT_HOW_IT_WORKS_COPY } from './how-it-works-copy.defaults';

/**
 * `/how-it-works` page copy (`copy.marketing.howItWorks`).
 *
 * #980: the compiled defaults live in this lazy chunk, not in
 * DEFAULT_APP_CONFIG, so the initial bundle doesn't carry them. Import this
 * only from lazy files — importing it from an eager file (app.ts,
 * app.config.ts, app.routes.ts, a root state or guard) would drag the copy
 * back into the initial bundle. Deploy overrides at
 * `copy.marketing.howItWorks` in app-config.json still apply. Call in an
 * injection context.
 */
export function injectHowItWorksCopy(): HowItWorksCopy {
  return mergeLazyCopy(inject(ConfigService), DEFAULT_HOW_IT_WORKS_COPY, ['marketing', 'howItWorks']);
}
