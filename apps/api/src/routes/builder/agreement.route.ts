/**
 * Thin builder agreement + onboarding route (#722).
 *
 * - `GET /api/v1/builder/agreement` — the org's acceptance status for the
 *   current agreement version, with the agreement text.
 * - `POST /api/v1/builder/agreement/accept` — accept the current version.
 *   Builder org admin only: members get 403 AGREEMENT_ADMIN_REQUIRED (the
 *   service decides). Records the client IP (#729 helper) and user agent.
 * - `GET /api/v1/builder/onboarding` — first-run checklist flags.
 *
 * All three take the builder org from the SESSION (never a request
 * param). The registry permission (`builder:leads:read`, held by both
 * builder roles) is enforced by the adapter's dispatch and again here.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  AcceptAgreementResponse,
  AgreementStatus,
  BuilderOnboardingStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import { clientIpFromHeaders } from '../../middleware/client-ip';
import type { PermissionGuard } from '../../middleware/permission-guard';
import type { BuilderAgreementService } from '../../services/builder-agreement.service';
import type { BuilderOnboardingService } from '../../services/builder-onboarding.service';

type Headers = Record<string, string | string[] | undefined>;

export interface BuilderAgreementRouteDeps {
  readonly agreements: BuilderAgreementService;
  readonly onboarding: BuilderOnboardingService;
  readonly permissionGuard: Pick<
    PermissionGuard,
    'requirePermission' | 'requireBuilderId'
  >;
}

export interface BuilderAgreementRoute {
  /** GET /api/v1/builder/agreement */
  getAgreement(headers: Headers): Promise<AgreementStatus>;
  /** POST /api/v1/builder/agreement/accept */
  accept(headers: Headers, body: unknown): Promise<AcceptAgreementResponse>;
  /** GET /api/v1/builder/onboarding */
  getOnboarding(headers: Headers): Promise<BuilderOnboardingStatus>;
}

const ROUTE_GET = 'GET /api/v1/builder/agreement';
const ROUTE_ACCEPT = 'POST /api/v1/builder/agreement/accept';
const ROUTE_ONBOARDING = 'GET /api/v1/builder/onboarding';

const acceptBodySchema = z.object({
  version: z.string().trim().min(1).max(100),
});

function headerValue(headers: Headers, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) continue;
    const v = Array.isArray(value) ? value[0] : value;
    return v === undefined || v.trim() === '' ? null : v.trim();
  }
  return null;
}

export function createBuilderAgreementRoute(
  deps: BuilderAgreementRouteDeps,
): BuilderAgreementRoute {
  const { agreements, onboarding, permissionGuard } = deps;

  async function orgContext(headers: Headers, route: string) {
    const ctx = await permissionGuard.requirePermission(
      'builder:leads:read',
      headers,
      route,
    );
    const builderId = await permissionGuard.requireBuilderId(ctx, route);
    return { ctx, builderId };
  }

  return {
    async getAgreement(headers): Promise<AgreementStatus> {
      const { ctx, builderId } = await orgContext(headers, ROUTE_GET);
      return agreements.getStatus(ctx, builderId);
    },

    async accept(headers, body): Promise<AcceptAgreementResponse> {
      const { ctx, builderId } = await orgContext(headers, ROUTE_ACCEPT);
      const parsed = acceptBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'An agreement version is required.',
          false,
        );
      }
      return agreements.accept(ctx, builderId, {
        version: parsed.data.version,
        ip: clientIpFromHeaders(headers) ?? null,
        userAgent: headerValue(headers, 'user-agent'),
      });
    },

    async getOnboarding(headers): Promise<BuilderOnboardingStatus> {
      const { ctx, builderId } = await orgContext(headers, ROUTE_ONBOARDING);
      return onboarding.getStatus(ctx, builderId);
    },
  };
}
