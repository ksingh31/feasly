/**
 * Thin builder-side view-as route (2026-09-30, Karan).
 *
 * Lets a `builder_admin` view the portal as a regular team member of
 * their own org — e.g. to check what a `builder_member` sees on the
 * leads pipeline.
 *
 * - `POST /api/v1/builder/view-as` — activate view-as (`{ userId }`).
 *   Requires the `view_as` permission (builder_admin only; enforced by
 *   the registry before the route runs, and again inside the service).
 * - `DELETE /api/v1/builder/view-as` — exit view-as. Session-only (exiting
 *   can never escalate — the borrowed view strips `view_as`, so this
 *   must NOT require the permission).
 *
 * Targets are userId-only and org-scoped inside the service: the target
 * must be a regular user (never a staff admin, never any builder_admin —
 * #394 lockdown) holding a membership in the caller's own org. Cross-org
 * targets are 403, never honored.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */

// ---------------------------------------------------------------------------
// Contract shapes — imported from `@feasly/contracts`, the single source
// of truth shared with the frontend lane.
// ---------------------------------------------------------------------------
import type {
  BuilderViewAsRequestBody,
  BuilderViewAsResponse,
} from '@feasly/contracts';
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { PermissionGuard } from '../../middleware/permission-guard';
import { extractSessionToken } from '../../middleware/session-token';
import { BUILDER_SESSION_COOKIE } from '../../middleware/builder-guard';
import type { BuilderViewAsService } from '../../services/builder-view-as.service';
import type { UserService } from '../../services/user.service';

export interface BuilderViewAsRouteDeps {
  readonly viewAs: BuilderViewAsService;
  readonly permissionGuard: PermissionGuard;
  readonly userService: Pick<UserService, 'findById'>;
}

export interface BuilderViewAsRoute {
  /** POST /api/v1/builder/view-as */
  activate(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<BuilderViewAsResponse>;
  /** DELETE /api/v1/builder/view-as */
  exit(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderViewAsResponse>;
}

const activateSchema: z.ZodType<BuilderViewAsRequestBody> = z.object({
  userId: z.string().trim().uuid(),
});

function requireSessionToken(
  headers: Record<string, string | string[] | undefined>,
): string {
  const token = extractSessionToken(headers, BUILDER_SESSION_COOKIE);
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

export function createBuilderViewAsRoute(
  deps: BuilderViewAsRouteDeps,
): BuilderViewAsRoute {
  const { viewAs, permissionGuard, userService } = deps;

  return {
    async activate(headers, body): Promise<BuilderViewAsResponse> {
      const actor = await permissionGuard.requirePermission(
        'view_as',
        headers,
        'POST /api/v1/builder/view-as',
      );
      const parsed = activateSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A valid userId is required.',
          false,
        );
      }
      const token = requireSessionToken(headers);
      await viewAs.activate(token, parsed.data.userId, actor);

      const user = await userService.findById(parsed.data.userId);
      return {
        active: true,
        target: {
          kind: 'user',
          id: parsed.data.userId,
          displayName: user?.name ?? parsed.data.userId,
        },
      };
    },

    async exit(headers): Promise<BuilderViewAsResponse> {
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
  };
}
