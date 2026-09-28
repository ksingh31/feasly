/**
 * Thin view-as route (auth/04). Routes are adapters, not logic: validate
 * input → call exactly one service method → return the result.
 *
 * - `POST /api/v1/admin/view-as` — activate view-as (`{ builderId }` or
 *   `{ userId }`). Requires the `view_as` permission (super_admin/admin).
 * - `DELETE /api/v1/admin/view-as` — exit view-as. Session-only (exiting
 *   can never escalate).
 * - `POST /api/v1/admin/auth/switch-builder` — switch the session's active
 *   builder. Session-only; the service 403s unless the builder is one of
 *   the caller's memberships.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  AdminSwitchBuilderRequestBody,
  AdminSwitchBuilderResponse,
  AdminViewAsRequestBody,
  AdminViewAsResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type {
  PermissionGuard,
} from '../middleware/permission-guard';
import { extractSessionToken } from '../middleware/session-token';
import { ADMIN_SESSION_COOKIE } from '../middleware/admin-guard';
import type { ViewAsService } from '../services/view-as.service';
import type { BuilderService } from '../services/builder.service';
import type { UserService } from '../services/user.service';

export interface AdminViewAsRouteDeps {
  readonly viewAs: ViewAsService;
  readonly permissionGuard: PermissionGuard;
  readonly builders: Pick<BuilderService, 'getBuilder'>;
  readonly userService: Pick<UserService, 'findById'>;
}

export interface AdminViewAsRoute {
  /** POST /api/v1/admin/view-as */
  activate(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<AdminViewAsResponse>;
  /** DELETE /api/v1/admin/view-as */
  exit(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AdminViewAsResponse>;
  /** POST /api/v1/admin/auth/switch-builder */
  switchBuilder(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<AdminSwitchBuilderResponse>;
}

const activateSchema = z.union([
  z.object({ builderId: z.string().trim().uuid() }),
  z.object({ userId: z.string().trim().uuid() }),
]);

const switchBuilderSchema: z.ZodType<AdminSwitchBuilderRequestBody> = z.object(
  {
    builderId: z.string().trim().uuid(),
  },
);

function requireSessionToken(
  headers: Record<string, string | string[] | undefined>,
): string {
  const token = extractSessionToken(headers, ADMIN_SESSION_COOKIE);
  if (!token) {
    throw new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'Authentication required.',
      false,
    );
  }
  return token;
}

export function createAdminViewAsRoute(
  deps: AdminViewAsRouteDeps,
): AdminViewAsRoute {
  const { viewAs, permissionGuard, builders, userService } = deps;

  return {
    async activate(headers, body): Promise<AdminViewAsResponse> {
      const actor = await permissionGuard.requirePermission(
        'view_as',
        headers,
        'POST /api/v1/admin/view-as',
      );
      const parsed = activateSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Provide exactly one of builderId or userId.',
          false,
        );
      }
      // Reject bodies that set BOTH keys — the union schema accepts them;
      // ambiguity here must never widen access.
      const raw = body as Record<string, unknown>;
      if (raw.builderId !== undefined && raw.userId !== undefined) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Provide exactly one of builderId or userId.',
          false,
        );
      }
      const token = requireSessionToken(headers);
      const target: AdminViewAsRequestBody = parsed.data;
      await viewAs.activate(token, target, actor);

      if ('builderId' in target) {
        const builder = await builders.getBuilder(target.builderId);
        return {
          active: true,
          target: {
            kind: 'builder',
            id: builder.id,
            displayName: builder.displayName,
          },
        };
      }
      const user = await userService.findById(target.userId);
      return {
        active: true,
        target: {
          kind: 'user',
          id: target.userId,
          displayName: user?.name ?? target.userId,
        },
      };
    },

    async exit(headers): Promise<AdminViewAsResponse> {
      const actor = await permissionGuard.getAuthContext(headers);
      if (!actor) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Authentication required.',
          false,
        );
      }
      const token = requireSessionToken(headers);
      await viewAs.exit(token, actor);
      return { active: false };
    },

    async switchBuilder(headers, body): Promise<AdminSwitchBuilderResponse> {
      const actor = await permissionGuard.getAuthContext(headers);
      if (!actor) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Authentication required.',
          false,
        );
      }
      const parsed = switchBuilderSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A valid builderId is required.',
          false,
        );
      }
      const token = requireSessionToken(headers);
      return viewAs.switchBuilder(token, parsed.data.builderId, actor);
    },
  };
}
