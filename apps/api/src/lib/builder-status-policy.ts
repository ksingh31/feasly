/**
 * Builder status policy (#860) — the ONE function every enforcement point
 * calls to decide what a builder's status allows. The matrix itself lives
 * in `@feasly/contracts` (`BUILDER_STATUS_POLICY`) so the portal can show
 * the same rules; this module adds the normalisation and the error shape.
 *
 * Enforcement points (each has a per-status test):
 * - embed config ............ builder-config.service.ts      → `embed`
 * - lead routing ............ lead.service.ts / lead-assignment.service.ts → `newLeads`
 * - new-lead notifications .. builder-notifications.service.ts → `newLeads`
 * - portal sign-in .......... auth-context.service.ts        → `signIn`
 * - portal leads ............ builder-leads.service.ts       → `portalRead` / `portalWrite`
 * - portal comments ......... builder-comments.service.ts    → `portalRead` / `portalWrite`
 * - billing reports ......... billing.service.ts             → `portalWrite`
 * - auto-charge ............. invoice-reviewer.service.ts    → `autoCharge`
 * - API keys ................ api-key.service.ts             → `apiKeys`
 *
 * Pure: no I/O.
 */
import {
  BUILDER_STATUS_POLICY,
  type BuilderCapability,
  type BuilderLifecycleAction,
  type BuilderStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';

/**
 * Normalise a stored status. Legacy `inactive` (pre-#860 rows the repair
 * SQL has not reached yet) reads as `suspended`; anything unknown is null
 * (deny everything — fail closed).
 */
export function normalizeBuilderStatus(
  status: string | null | undefined,
): BuilderStatus | null {
  if (status === 'inactive') return 'suspended';
  if (
    status === 'active' ||
    status === 'suspended' ||
    status === 'offboarding' ||
    status === 'offboarded'
  ) {
    return status;
  }
  return null;
}

/** True when a builder in `status` may use `capability`. Unknown → false. */
export function builderStatusAllows(
  status: string | null | undefined,
  capability: BuilderCapability,
): boolean {
  const normalized = normalizeBuilderStatus(status);
  return normalized !== null && BUILDER_STATUS_POLICY[normalized][capability];
}

/**
 * The 403 a builder gets when its status refuses an action (the portal
 * shows the "account paused" screen on this code).
 */
export function builderPausedError(status: string | null | undefined): HttpError {
  const normalized = normalizeBuilderStatus(status) ?? 'unknown';
  return new HttpError(
    403,
    ErrorCodes.BUILDER_PAUSED,
    normalized === 'offboarded'
      ? 'This builder account is closed. Contact Feasly for help.'
      : 'This builder account is paused. Contact Feasly to restore access.',
    false,
  );
}

/** Throw {@link builderPausedError} unless `status` allows `capability`. */
export function requireBuilderCapability(
  status: string | null | undefined,
  capability: BuilderCapability,
): void {
  if (!builderStatusAllows(status, capability)) {
    throw builderPausedError(status);
  }
}

/** Admin lifecycle actions (#860), in the order the admin UI offers them. */
export const BUILDER_LIFECYCLE_ACTIONS: readonly BuilderLifecycleAction[] = [
  'suspend',
  'reactivate',
  'start_offboarding',
  'complete_offboarding',
];

/** A lifecycle reason is mandatory: 3–1000 characters after trimming. */
export const MIN_STATUS_REASON = 3;
export const MAX_STATUS_REASON = 1000;
