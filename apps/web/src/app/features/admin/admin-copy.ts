import { inject } from '@angular/core';
import type { AdminCopy } from '@app/core/config/app-config';
import { ConfigService } from '@app/core/config/config.service';
import { mergeLazyCopy } from '@app/core/config/lazy-copy';
import { DEFAULT_ADMIN_COPY } from './admin-copy.defaults';

/**
 * Admin console copy (`copy.admin`).
 *
 * #980: the compiled defaults live in the lazy admin chunk, not in
 * DEFAULT_APP_CONFIG, so the initial bundle doesn't carry them. Import this
 * only from lazy admin files — importing it from an eager file (app.ts,
 * app.config.ts, app.routes.ts, the admin guard or admin-auth state) would
 * drag the copy back into the initial bundle. Deploy overrides at
 * `copy.admin` in app-config.json still apply. Call in an injection context.
 */
export function injectAdminCopy(): AdminCopy {
  return mergeLazyCopy(inject(ConfigService), DEFAULT_ADMIN_COPY, ['admin']);
}
