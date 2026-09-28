/**
 * BuilderEntraCallbackService (auth/05) — the backend half of builder
 * Entra sign-in.
 *
 * `POST /api/v1/builder/auth/entra/callback` flow:
 * 1. Zod-validate `{ code, codeVerifier, redirectUri }`.
 * 2. Exchange the code for an id_token (builder EntraTokenValidator —
 *    separate app registration / user flow from the admin one).
 * 3. Validate the id_token (signature, iss, aud, exp).
 * 4. Resolve our user via the typed Drizzle `UserStore`:
 *    - unknown email or `disabled` → 403 with buyer-grade copy — no
 *      enumeration beyond that message;
 *    - user with NO builder_memberships → 403 (not a builder user);
 *    - row already linked to this Entra object id → returning sign-in;
 *    - `invited` row → `UserService.completeInvitation` links the Entra
 *      object id, accepts the invitation, flips invited → active;
 *    - active-but-never-linked row → link directly.
 *    A token whose object id doesn't match the linked account is rejected.
 * 5. Mint a 7-day session in `builder_sessions` bound to the user id and
 *    the active builder id (first membership by default), reusing the
 *    existing SHA-256 token-hash + httpOnly cookie discipline.
 * 6. Return `{ authenticated, user: { email, name, memberships },
 *    activeBuilderId, sessionToken }` — Entra tokens never leave the
 *    backend.
 *
 * PLACEHOLDER (2026-09-28): the builder Entra External ID app
 * registration / user flow is not yet provisioned in the Azure portal.
 * The validator's `configured` flag is false until Karan provisions it —
 * the service 503s fail-closed meanwhile (same pattern as the admin
 * callback, auth/02).
 *
 * Never logs the code, code verifier, or tokens. Body-validation failures
 * log only field NAMES and failure kinds — never values.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BuilderEntraCallbackResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import { hashSessionToken } from './admin-auth.service';
import type { BuilderSessionStore } from './builder-auth.service';
import type { EntraTokenValidator } from './entra-token-validator';
import type {
  BuilderMembership,
  PublicUser,
  UserService,
  UserStore,
} from './user.service';
import type { BuilderService } from './builder.service';

export interface BuilderEntraCallbackService {
  /**
   * Handle the PKCE callback. Returns the session identity plus the raw
   * session token exactly once (the adapter sets it as the httpOnly
   * cookie and returns it in the JSON body for the SPA bearer flow).
   * The shape is `BuilderEntraCallbackResponse` from `@feasly/contracts`.
   */
  handleCallback(body: unknown): Promise<BuilderEntraCallbackResponse>;
  /**
   * List the user's org memberships with resolved builder names.
   * Throws 401 when the user is unknown/disabled.
   */
  listMemberships(userId: string): Promise<{
    readonly memberships: BuilderEntraCallbackResponse['user']['memberships'];
  }>;
  /**
   * Switch the session's active builder. The builder id must be one of
   * the user's memberships, else 403. Returns the new active builder id
   * and name. Throws 401 when the session is unknown/revoked.
   */
  setActiveOrg(
    sessionTokenHash: string,
    userId: string,
    builderId: string,
  ): Promise<{ readonly activeBuilderId: string; readonly builderName: string }>;
}

export interface BuilderEntraCallbackServiceDeps {
  readonly tokenValidator: EntraTokenValidator;
  /** Typed Drizzle store — user lookup + direct linking. */
  readonly users: UserStore;
  /** Invitation acceptance + public user shape (with memberships). */
  readonly userService: UserService;
  readonly sessions: BuilderSessionStore;
  /** Resolve builder rows for membership summaries. */
  readonly builders: Pick<BuilderService, 'getBuilder'>;
  readonly audit: Pick<AdminAuditStore, 'log'>;
  /** Builder session TTL in seconds (7 days, same as admin) — from config. */
  readonly builderSessionTtlSeconds: number;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
}

const callbackBodySchema = z.object({
  code: z.string().trim().min(1).max(10_000),
  codeVerifier: z.string().trim().min(1).max(10_000),
  redirectUri: z.string().trim().min(1).max(2_000),
});

/**
 * Diagnostic cause for callback body-validation failures. Field names and
 * failure kinds only — never values (no codes, verifiers, tokens).
 */
function bodyValidationCause(body: unknown): string {
  const fields: ReadonlyArray<{ readonly name: string; readonly max: number }> =
    [
      { name: 'code', max: 10_000 },
      { name: 'codeVerifier', max: 10_000 },
      { name: 'redirectUri', max: 2_000 },
    ];
  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : null;
  const reasons: string[] = [];
  for (const { name, max } of fields) {
    const value = record?.[name];
    if (value === undefined || value === null) {
      reasons.push(`${name}:missing`);
    } else if (typeof value !== 'string') {
      reasons.push(`${name}:wrong-type:${typeof value}`);
    } else if (value.trim().length === 0) {
      reasons.push(`${name}:empty`);
    } else if (value.length > max) {
      reasons.push(`${name}:too-long`);
    }
  }
  return `builder_entra_callback_body_invalid fields=${reasons.join(',') || 'none'}`;
}

/**
 * Buyer-grade denial for unknown, disabled, or non-builder accounts.
 * Identical copy in all cases — no enumeration oracle.
 */
function unknownAccount(): HttpError {
  return new HttpError(
    403,
    ErrorCodes.FORBIDDEN,
    'We couldn\u2019t find your Feasly builder account — ask your builder admin for an invite.',
    false,
  );
}

/** Uniform 401 — never reveal which identity check failed (no oracle). */
function signInIncomplete(): HttpError {
  return new HttpError(
    401,
    ErrorCodes.UNAUTHENTICATED,
    'Sign-in didn\u2019t complete — try again.',
    false,
  );
}

export function createBuilderEntraCallbackService(
  deps: BuilderEntraCallbackServiceDeps,
): BuilderEntraCallbackService {
  const {
    tokenValidator,
    users,
    userService,
    sessions,
    builders,
    audit,
    builderSessionTtlSeconds,
    clock = () => new Date(),
    uuid = randomUUID,
  } = deps;

  async function resolveUser(
    entraObjectId: string,
    email: string,
  ): Promise<PublicUser> {
    const record = await users.findByEmail(email);
    if (!record || record.status === 'disabled') {
      await audit.log({
        actorEmail: null,
        action: 'auth_failed',
        detail: 'builder_entra_callback_unknown_user',
      });
      throw unknownAccount();
    }
    if (record.entraObjectId === entraObjectId) {
      // Returning sign-in — this Entra identity is already linked.
      const user = await userService.findByEmail(email);
      if (!user) throw unknownAccount();
      return user;
    }
    if (record.entraObjectId !== null) {
      // The token's Entra identity doesn't match the linked account.
      await audit.log({
        actorEmail: record.email,
        action: 'auth_failed',
        detail: 'builder_entra_callback_identity_mismatch',
      });
      throw signInIncomplete();
    }
    // First sign-in — link this Entra identity to the row.
    if (!record.isProtected && record.status === 'invited') {
      try {
        const linked = await userService.completeInvitation(
          email,
          entraObjectId,
        );
        await audit.log({
          actorEmail: linked.email,
          action: 'entra_account_linked',
          detail: 'builder_signin_first',
        });
        return linked;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          await audit.log({
            actorEmail: null,
            action: 'auth_failed',
            detail: 'builder_entra_callback_unknown_user',
          });
          throw unknownAccount();
        }
        throw error;
      }
    }
    // Active row that was never linked: link directly.
    await users.updateUser(
      record.id,
      { status: 'active', entraObjectId },
      clock(),
    );
    await audit.log({
      actorEmail: record.email,
      action: 'entra_account_linked',
      detail: 'builder_signin_first',
    });
    const user = await userService.findByEmail(email);
    if (!user) throw unknownAccount();
    return user;
  }

  return {
    async handleCallback(body: unknown) {
      const parsed = callbackBodySchema.safeParse(body);
      if (!parsed.success) {
        const error = new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Sign-in didn\u2019t complete — try again.',
          false,
        );
        error.cause = new Error(bodyValidationCause(body));
        throw error;
      }
      const { code, codeVerifier, redirectUri } = parsed.data;

      const { idToken } = await tokenValidator.exchangeCode({
        code,
        codeVerifier,
        redirectUri,
      });
      const identity = await tokenValidator.validateIdToken(idToken);

      const user = await resolveUser(identity.entraObjectId, identity.email);

      // Builder gate: the user must have at least one builder membership.
      // Staff-only users (no memberships) get the same 403 as unknown
      // accounts — no enumeration.
      if (user.memberships.length === 0) {
        await audit.log({
          actorEmail: user.email,
          action: 'auth_failed',
          detail: 'builder_entra_callback_no_membership',
        });
        throw unknownAccount();
      }

      // Active org = first membership by default; the org switcher can
      // change it later via POST /api/v1/builder/auth/active-org.
      const activeMembership: BuilderMembership = user.memberships[0]!;
      const membershipSummaries = await Promise.all(
        user.memberships.map(async (m) => {
          let builderName = m.builderId;
          let tenantKey = m.builderId;
          try {
            const builder = await builders.getBuilder(m.builderId);
            builderName = builder.displayName;
            tenantKey = builder.tenantKey;
          } catch {
            // Builder row gone — keep the id so the UI can show something.
          }
          return {
            builderId: m.builderId,
            tenantKey,
            builderName,
            role: m.role,
          };
        }),
      );

      const now = clock();
      const sessionToken = randomBytes(32).toString('hex');
      // Resolve the tenant key for the active org (legacy column kept for
      // the builder guard's tenant fallback).
      let tenantKey = activeMembership.builderId;
      try {
        tenantKey = (await builders.getBuilder(activeMembership.builderId))
          .tenantKey;
      } catch {
        // Fall through with the builder id as tenant key.
      }
      await sessions.insert({
        id: uuid(),
        email: user.email,
        tenantKey,
        builderId: activeMembership.builderId,
        sessionTokenHash: hashSessionToken(sessionToken),
        userId: user.id,
        expiresAt: new Date(now.getTime() + builderSessionTtlSeconds * 1000),
      });
      await audit.log({
        actorEmail: user.email,
        action: 'session_created',
        detail: 'builder_entra_callback',
      });

      return {
        authenticated: true as const,
        user: {
          email: user.email,
          name: user.name,
          memberships: membershipSummaries,
        },
        activeBuilderId: activeMembership.builderId,
        sessionToken,
      };
    },

    async listMemberships(userId: string) {
      const user = await userService.findById(userId);
      if (!user || user.status === 'disabled') {
        throw signInIncomplete();
      }
      const memberships = await Promise.all(
        user.memberships.map(async (m) => {
          let builderName = m.builderId;
          let tenantKey = m.builderId;
          try {
            const builder = await builders.getBuilder(m.builderId);
            builderName = builder.displayName;
            tenantKey = builder.tenantKey;
          } catch {
            // Builder row gone — keep the id so the UI can show something.
          }
          return {
            builderId: m.builderId,
            tenantKey,
            builderName,
            role: m.role,
          };
        }),
      );
      return { memberships };
    },

    async setActiveOrg(sessionTokenHash, userId, builderId) {
      const user = await userService.findById(userId);
      if (!user || user.status === 'disabled') {
        throw signInIncomplete();
      }
      const membership = user.memberships.find(
        (m) => m.builderId === builderId,
      );
      if (!membership) {
        // Not one of the caller's orgs — 403, no enumeration.
        await audit.log({
          actorEmail: user.email,
          action: 'auth_failed',
          detail: 'builder_active_org_forbidden',
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You don\u2019t have access to this.',
          false,
        );
      }
      const switched = await sessions.updateBuilderId(
        sessionTokenHash,
        builderId,
      );
      if (!switched) {
        throw signInIncomplete();
      }
      let builderName = builderId;
      try {
        builderName = (await builders.getBuilder(builderId)).displayName;
      } catch {
        // Keep the id.
      }
      await audit.log({
        actorEmail: user.email,
        action: 'builder_active_org_switched',
        detail: `builder_id=${builderId}`,
      });
      return { activeBuilderId: builderId, builderName };
    },
  };
}
