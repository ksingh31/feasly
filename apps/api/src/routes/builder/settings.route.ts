/**
 * Thin builder Settings route (#870).
 *
 * - `GET /api/v1/builder/profile` — profile & branding + support contact
 *   (any org member; `canEdit` tells the UI whether to show the form).
 * - `PUT /api/v1/builder/profile` — partial update, org owners only
 *   (`builder:settings:manage`; members get 403).
 * - `GET /api/v1/builder/embed` — install snippet, allowed origins
 *   (read-only) and per-origin install check (any org member).
 * - `POST /api/v1/builder/embed/origin-requests` — "Request a change" for
 *   allowed origins; creates one admin task (org owners only).
 *
 * The org comes from the SESSION (`requireBuilderId`), never the request.
 * Writes are refused while viewing as a teammate (403) so every audit row
 * names the person who actually made the change.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type {
  BuilderEmbedResponse,
  BuilderOriginRequestResponse,
  BuilderProfileResponse,
} from '@feasly/contracts';
import { hasPermission } from '../../auth/permissions';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { PermissionGuard } from '../../middleware/permission-guard';
import type {
  BuilderSettingsActor,
  BuilderSettingsService,
} from '../../services/builder-settings.service';

type Headers = Record<string, string | string[] | undefined>;

export const BUILDER_SETTINGS_MANAGE_PERMISSION = 'builder:settings:manage' as const;

export interface BuilderSettingsRouteDeps {
  readonly settings: BuilderSettingsService;
  readonly permissionGuard: Pick<
    PermissionGuard,
    'requirePermission' | 'requireBuilderId'
  >;
}

export interface BuilderSettingsRoute {
  /** GET /api/v1/builder/profile */
  getProfile(headers: Headers): Promise<BuilderProfileResponse>;
  /** PUT /api/v1/builder/profile */
  updateProfile(headers: Headers, body: unknown): Promise<BuilderProfileResponse>;
  /** GET /api/v1/builder/embed */
  getEmbed(headers: Headers): Promise<BuilderEmbedResponse>;
  /** POST /api/v1/builder/embed/origin-requests */
  requestOriginChange(
    headers: Headers,
    body: unknown,
  ): Promise<BuilderOriginRequestResponse>;
}

const ROUTE_PROFILE_GET = 'GET /api/v1/builder/profile';
const ROUTE_PROFILE_PUT = 'PUT /api/v1/builder/profile';
const ROUTE_EMBED_GET = 'GET /api/v1/builder/embed';
const ROUTE_ORIGIN_REQUEST = 'POST /api/v1/builder/embed/origin-requests';

export function createBuilderSettingsRoute(
  deps: BuilderSettingsRouteDeps,
): BuilderSettingsRoute {
  const { settings, permissionGuard } = deps;

  async function readActor(headers: Headers, route: string): Promise<BuilderSettingsActor> {
    const ctx = await permissionGuard.requirePermission('builder:leads:read', headers, route);
    const builderId = await permissionGuard.requireBuilderId(ctx, route);
    return {
      builderId,
      userId: ctx.userId,
      email: ctx.email,
      canEdit:
        ctx.viewAs === null &&
        hasPermission(ctx.permissions, BUILDER_SETTINGS_MANAGE_PERMISSION),
    };
  }

  async function ownerActor(headers: Headers, route: string): Promise<BuilderSettingsActor> {
    const ctx = await permissionGuard.requirePermission(
      BUILDER_SETTINGS_MANAGE_PERMISSION,
      headers,
      route,
    );
    const builderId = await permissionGuard.requireBuilderId(ctx, route);
    if (ctx.viewAs !== null) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'Settings can’t be changed while viewing as a teammate.',
        false,
      );
    }
    return { builderId, userId: ctx.userId, email: ctx.email, canEdit: true };
  }

  return {
    async getProfile(headers) {
      return settings.getProfile(await readActor(headers, ROUTE_PROFILE_GET));
    },
    async updateProfile(headers, body) {
      return settings.updateProfile(await ownerActor(headers, ROUTE_PROFILE_PUT), body);
    },
    async getEmbed(headers) {
      return settings.getEmbed(await readActor(headers, ROUTE_EMBED_GET));
    },
    async requestOriginChange(headers, body) {
      return settings.requestOriginChange(
        await ownerActor(headers, ROUTE_ORIGIN_REQUEST),
        body,
      );
    },
  };
}
