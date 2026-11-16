/**
 * Thin builder notification-preferences route (#725).
 *
 * - `GET /api/v1/builder/notifications/preferences` — the signed-in
 *   member's email preferences (new-lead, daily digest, billing) with the
 *   defaults applied, their org role, and whether they may turn billing
 *   emails off (the org's last admin receiving them may not).
 * - `PUT` — partial update; 409 LAST_ADMIN for the last billing admin,
 *   403 while viewing as a teammate.
 *
 * Any org member (`builder:leads:read`, enforced by the registry before the
 * route runs). The org and the member come from the session, never the
 * request.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { BuilderNotificationPreferencesResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { BuilderGuard } from '../../middleware/builder-guard';
import type {
  BuilderNotificationsService,
  NotificationSessionRef,
} from '../../services/builder-notifications.service';

type Headers = Record<string, string | string[] | undefined>;

export interface BuilderNotificationsRouteDeps {
  readonly notifications: Pick<
    BuilderNotificationsService,
    'getPreferences' | 'updatePreferences'
  >;
  readonly builderGuard: Pick<BuilderGuard, 'getBuilderSession'>;
}

export interface BuilderNotificationsRoute {
  /** GET /api/v1/builder/notifications/preferences */
  getPreferences(headers: Headers): Promise<BuilderNotificationPreferencesResponse>;
  /** PUT /api/v1/builder/notifications/preferences */
  updatePreferences(
    headers: Headers,
    body: unknown,
  ): Promise<BuilderNotificationPreferencesResponse>;
}

export function createBuilderNotificationsRoute(
  deps: BuilderNotificationsRouteDeps,
): BuilderNotificationsRoute {
  const { notifications, builderGuard } = deps;

  async function requireSession(headers: Headers): Promise<NotificationSessionRef> {
    const session = await builderGuard.getBuilderSession(headers);
    if (!session) {
      throw new HttpError(
        401,
        ErrorCodes.UNAUTHENTICATED,
        'Builder authentication required.',
        false,
      );
    }
    return session;
  }

  return {
    async getPreferences(headers) {
      return notifications.getPreferences(await requireSession(headers));
    },
    async updatePreferences(headers, body) {
      return notifications.updatePreferences(await requireSession(headers), body);
    },
  };
}
