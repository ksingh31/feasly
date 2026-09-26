import type { BuilderLeadStatus } from '@feasly/contracts';

/**
 * Builder portal actions (embed/09). All builder session and pipeline state
 * lives in BuilderState — components dispatch and render selectors, never
 * call the API directly.
 */

/** Verifies a builder magic-link token (from the email URL). */
export class VerifyBuilderToken {
  static readonly type = '[Builder] Verify token';
  constructor(public readonly token: string) {}
}

/** Probes the current builder session (cookie-based). */
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
