import type { BuilderLeadStatus } from '@feasly/contracts';
import type {
  BuilderOrgMembership,
  EntraCallbackErrorKind,
} from './builder-auth.contracts';

/**
 * Builder portal actions (embed/09, auth/05). All builder session and
 * pipeline state lives in BuilderState — components dispatch and render
 * selectors, never call the API directly.
 */

/** Verifies a builder magic-link token (from the email URL). */
export class VerifyBuilderToken {
  static readonly type = '[Builder] Verify token';
  constructor(public readonly token: string) {}
}

/** Probes the current builder session (bearer token). */
export class LoadBuilderSession {
  static readonly type = '[Builder] Load session';
}

/** Loads the tenant-scoped lead pipeline + summary. */
export class LoadBuilderLeads {
  static readonly type = '[Builder] Load leads';
}

/** Transitions a lead's pipeline status (contacted/quoted/won/lost). */
export class UpdateBuilderLeadStatus {
  static readonly type = '[Builder] Update lead status';
  constructor(
    public readonly leadId: string,
    public readonly status: BuilderLeadStatus,
  ) {}
}

/** Ends the builder session (logout). */
export class LogoutBuilder {
  static readonly type = '[Builder] Logout';
}

/** Resets all builder state (after logout or failed verify). */
export class ClearBuilderState {
  static readonly type = '[Builder] Clear state';
}

// ------------------------------------------------------------------
// auth/05 (builder org accounts) — Entra sign-in + org context.
// ------------------------------------------------------------------

/** Completes the Entra sign-in after the callback exchange succeeds. */
export class CompleteBuilderEntraSignIn {
  static readonly type = '[Builder] Complete Entra sign-in';
  constructor(
    public readonly sessionToken: string,
    public readonly email: string,
    public readonly name: string,
    public readonly memberships: readonly BuilderOrgMembership[],
  ) {}
}

/** Records a failed Entra callback (cancelled / state-mismatch / transient). */
export class FailBuilderEntraSignIn {
  static readonly type = '[Builder] Fail Entra sign-in';
  constructor(public readonly error: EntraCallbackErrorKind) {}
}

/** Sets the session's active org after the picker or switcher choice. */
export class SetBuilderActiveOrg {
  static readonly type = '[Builder] Set active org';
  constructor(
    public readonly builderId: string,
    public readonly builderName: string,
    public readonly role: 'builder_admin' | 'builder_member',
  ) {}
}

/** Reloads the user's memberships (org picker). */
export class LoadBuilderMemberships {
  static readonly type = '[Builder] Load memberships';
}
