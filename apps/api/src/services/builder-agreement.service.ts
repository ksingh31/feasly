/**
 * Platform agreement (clickwrap) service (#722).
 *
 * - `getStatus` — the org's acceptance state for the CURRENT version plus
 *   the served (draft) agreement text.
 * - `accept` — builder org admin only (403 AGREEMENT_ADMIN_REQUIRED for
 *   members, view-as sessions and staff without an admin membership). The
 *   submitted version must equal the current one (409
 *   AGREEMENT_VERSION_MISMATCH — the page is stale). Appends one row with
 *   version, time, user, client IP and user agent; re-accepting a version
 *   already on record appends nothing.
 * - `AgreementGate` — the money-action gate. `requireCurrentForTenant`
 *   throws 409 AGREEMENT_REQUIRED unless the org has accepted the current
 *   version. Used by report-contract, mark-won with contract details, card
 *   setup and the invoice reviewer's finalise step.
 *
 * "Current" = an acceptance whose version === `config.agreement.version`.
 * Bumping the config version keeps old rows (append-only) but they stop
 * counting, which forces re-acceptance on next sign-in.
 *
 * Only services and composition.ts may import from src/db/ — this service
 * depends on the store interface.
 */
import { randomUUID } from 'node:crypto';
import {
  AgreementErrorCodes,
  type AdminBuilderAgreementSummary,
  type AgreementAcceptedBy,
  type AgreementDocument,
  type AgreementStatus,
} from '@feasly/contracts';
import { HttpError } from '../middleware/errors';
import { PLATFORM_AGREEMENT_DRAFT } from '../lib/legal-copy';
import type { AuthContext } from './auth-context.service';
import type {
  AgreementAcceptanceRecord,
  BuilderAgreementStore,
} from './builder-agreement.store';

/** Longest User-Agent kept on the record (headers are caller-controlled). */
const MAX_USER_AGENT_LENGTH = 512;

/** The gate every money action calls. Keyed by tenant (billing's join key). */
export interface AgreementGate {
  /** True when the org behind `tenantKey` accepted the current version. */
  isCurrentForTenant(tenantKey: string): Promise<boolean>;
  /** Throws 409 AGREEMENT_REQUIRED unless `isCurrentForTenant`. */
  requireCurrentForTenant(tenantKey: string): Promise<void>;
}

export interface AcceptAgreementInput {
  readonly version: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface BuilderAgreementService extends AgreementGate {
  /** The configured current agreement version. */
  readonly currentVersion: string;
  /** True when `ctx` is an admin of `builderId` acting as themselves. */
  isOrgAdmin(ctx: AuthContext, builderId: string): boolean;
  /** Acceptance status of the current version for the caller's org. */
  getStatus(ctx: AuthContext, builderId: string): Promise<AgreementStatus>;
  /** Accept the current version on behalf of the org (admin only). */
  accept(
    ctx: AuthContext,
    builderId: string,
    input: AcceptAgreementInput,
  ): Promise<AgreementStatus>;
  /** Admin builder drawer block (latest acceptance of any version). */
  getAdminSummary(builderId: string): Promise<AdminBuilderAgreementSummary>;
}

export interface BuilderAgreementServiceDeps {
  readonly store: BuilderAgreementStore;
  /** `config.agreement.version` — the current agreement version. */
  readonly currentVersion: string;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
}

/** The 409 every gated money action answers without a current acceptance. */
export function agreementRequiredError(): HttpError {
  return new HttpError(
    409,
    AgreementErrorCodes.AGREEMENT_REQUIRED,
    'Your organisation needs to accept the current platform agreement first. ' +
      'An admin can accept it in the portal.',
    false,
  );
}

function toAcceptedBy(record: AgreementAcceptanceRecord): AgreementAcceptedBy {
  return {
    userId: record.acceptedByUserId,
    name: record.acceptedByName,
    email: record.acceptedByEmail,
  };
}

export function createBuilderAgreementService(
  deps: BuilderAgreementServiceDeps,
): BuilderAgreementService {
  const {
    store,
    currentVersion,
    clock = () => new Date(),
    uuid = randomUUID,
  } = deps;

  const document: AgreementDocument = {
    version: currentVersion,
    title: PLATFORM_AGREEMENT_DRAFT.title,
    status: PLATFORM_AGREEMENT_DRAFT.status,
    sections: PLATFORM_AGREEMENT_DRAFT.sections.map((section) => ({
      heading: section.heading,
      paragraphs: [...section.paragraphs],
    })),
  };

  function isOrgAdmin(ctx: AuthContext, builderId: string): boolean {
    // View-as borrows another user's view: never accept a legal agreement
    // under a borrowed identity. Legacy magic-link sessions have no user
    // row to attribute the acceptance to.
    if (ctx.viewAs !== null || ctx.realUser !== null || ctx.userId === null) {
      return false;
    }
    return ctx.memberships.some(
      (m) => m.builderId === builderId && m.role === 'builder_admin',
    );
  }

  async function statusFor(
    ctx: AuthContext,
    builderId: string,
  ): Promise<AgreementStatus> {
    const accepted = await store.findLatest(builderId, currentVersion);
    return {
      version: currentVersion,
      current: accepted !== null,
      acceptedAt: accepted ? accepted.acceptedAt.toISOString() : null,
      acceptedBy: accepted ? toAcceptedBy(accepted) : null,
      canAccept: isOrgAdmin(ctx, builderId),
      document,
    };
  }

  async function isCurrentForTenant(tenantKey: string): Promise<boolean> {
    return store.hasAcceptanceForTenant(tenantKey, currentVersion);
  }

  return {
    currentVersion,
    isOrgAdmin,
    isCurrentForTenant,

    async requireCurrentForTenant(tenantKey: string): Promise<void> {
      if (!(await isCurrentForTenant(tenantKey))) {
        throw agreementRequiredError();
      }
    },

    async getStatus(ctx, builderId): Promise<AgreementStatus> {
      return statusFor(ctx, builderId);
    },

    async accept(ctx, builderId, input): Promise<AgreementStatus> {
      if (!isOrgAdmin(ctx, builderId) || ctx.userId === null) {
        throw new HttpError(
          403,
          AgreementErrorCodes.AGREEMENT_ADMIN_REQUIRED,
          'Only an admin of your organisation can accept the platform agreement.',
          false,
        );
      }
      if (input.version !== currentVersion) {
        throw new HttpError(
          409,
          AgreementErrorCodes.AGREEMENT_VERSION_MISMATCH,
          'The platform agreement has been updated. Reload the page to review the current version.',
          false,
        );
      }
      const existing = await store.findLatest(builderId, currentVersion);
      if (existing === null) {
        await store.insert({
          id: uuid(),
          builderId,
          version: currentVersion,
          acceptedAt: clock(),
          acceptedByUserId: ctx.userId,
          acceptedByEmail: ctx.email,
          ip: input.ip,
          userAgent:
            input.userAgent === null
              ? null
              : input.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
        });
      }
      return statusFor(ctx, builderId);
    },

    async getAdminSummary(builderId): Promise<AdminBuilderAgreementSummary> {
      const latest = await store.findLatest(builderId);
      return {
        currentVersion,
        current: latest !== null && latest.version === currentVersion,
        acceptedVersion: latest?.version ?? null,
        acceptedAt: latest ? latest.acceptedAt.toISOString() : null,
        acceptedBy: latest ? toAcceptedBy(latest) : null,
      };
    },
  };
}
