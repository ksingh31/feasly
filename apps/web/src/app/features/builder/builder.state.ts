import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type {
  BuilderLeadListItem,
  BuilderLeadListResponse,
  BuilderLeadStatus,
} from '@feasly/contracts';
import type {
  BuilderOrgMembership,
  BuilderSessionIdentity,
  EntraCallbackErrorKind,
} from './builder-auth.contracts';
import { BuilderAuthApiService } from './builder-auth-api.service';
import { BuilderEntraAuthService } from './builder-entra-auth.service';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import {
  ClearBuilderState,
  CompleteBuilderEntraSignIn,
  FailBuilderEntraSignIn,
  LoadBuilderLeads,
  LoadBuilderMemberships,
  LoadBuilderSession,
  LogoutBuilder,
  SetBuilderActiveOrg,
  UpdateBuilderLeadStatus,
} from './builder.actions';

/** Auth lifecycle for the builder portal. */
export type BuilderAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

/** Loading lifecycle for the lead pipeline. */
export type BuilderLeadsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BuilderStateModel {
  /**
   * The builder session token (from the verify JSON body). Sent back as
   * `Authorization: Bearer <token>` by the credentials interceptor.
   * Persisted via the NGXS storage plugin so the builder session survives
   * a reload — the cross-origin session cookie never sticks on modern
   * browsers. Everything else in this slice stays memory-only (see below).
   */
  sessionToken: string | null;
  /** Session identity (email + org context), memory-only — never persisted. */
  session: BuilderSessionIdentity | null;
  authStatus: BuilderAuthStatus;
  /** True when the last /me probe failed with SESSION_EXPIRED (login copy). */
  sessionExpired: boolean;
  /**
   * auth/05: the user's builder memberships (org picker + switcher).
   * Memory-only — refetched on mount.
   */
  memberships: readonly BuilderOrgMembership[];
  /** True while the membership list is loading (org picker). */
  membershipsLoading: boolean;
  /** True when the last membership load failed. */
  membershipsError: boolean;
  /**
   * Classification of the last Entra callback failure (null when the last
   * callback succeeded or none has run). Read by the callback page.
   */
  lastEntraError: EntraCallbackErrorKind | null;
  /** Tenant-scoped leads, memory-only (homeowner PII — never persisted). */
  leads: readonly BuilderLeadListItem[];
  summary: BuilderLeadListResponse['summary'];
  leadsStatus: BuilderLeadsStatus;
  /** Lead id currently being status-updated (disables its action buttons). */
  updatingLeadId: string | null;
  /** Last lead-update failure: 'forbidden' | 'failed' | null. */
  updateError: string | null;
}

export const EMPTY_SUMMARY: BuilderLeadListResponse['summary'] = {
  total: 0,
  new: 0,
  contacted: 0,
  quoted: 0,
  won: 0,
  lost: 0,
};

const defaults: BuilderStateModel = {
  sessionToken: null,
  session: null,
  authStatus: 'unknown',
  sessionExpired: false,
  memberships: [],
  membershipsLoading: false,
  membershipsError: false,
  lastEntraError: null,
  leads: [],
  summary: EMPTY_SUMMARY,
  leadsStatus: 'idle',
  updatingLeadId: null,
  updateError: null,
};

/**
 * Builder portal state (embed/09): the single source of truth for the
 * `/builder/*` portal.
 *
 * The session token is bearer-based (`Authorization: Bearer <token>`,
 * attached by the credentials interceptor) and persisted via the NGXS
 * storage plugin so the portal survives a reload — the cross-origin
 * session cookie never sticks on modern browsers. Everything else is
 * memory-only: the session identity and the lead list (homeowner PII)
 * are stripped before persistence and refetched on mount.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription.
 */
@State<BuilderStateModel>({
  name: 'builder',
  defaults,
})
@Injectable()
export class BuilderState {
  private readonly authApi = inject(BuilderAuthApiService);
  private readonly entraAuth = inject(BuilderEntraAuthService);
  private readonly leadsApi = inject(BuilderLeadsApiService);

  @Selector()
  static session(state: BuilderStateModel): BuilderSessionIdentity | null {
    return state.session;
  }

  @Selector()
  static sessionToken(state: BuilderStateModel): string | null {
    return state.sessionToken;
  }

  @Selector()
  static authStatus(state: BuilderStateModel): BuilderAuthStatus {
    return state.authStatus;
  }

  @Selector()
  static sessionExpired(state: BuilderStateModel): boolean {
    return state.sessionExpired;
  }

  @Selector()
  static authenticated(state: BuilderStateModel): boolean {
    return state.authStatus === 'authenticated';
  }

  /** auth/05: true once the session has been probed (authenticated or not). */
  @Selector()
  static sessionLoaded(state: BuilderStateModel): boolean {
    return state.authStatus !== 'unknown';
  }

  /** auth/05: the user's builder memberships (org picker + switcher). */
  @Selector()
  static memberships(state: BuilderStateModel): readonly BuilderOrgMembership[] {
    return state.memberships;
  }

  @Selector()
  static membershipsLoading(state: BuilderStateModel): boolean {
    return state.membershipsLoading;
  }

  @Selector()
  static membershipsError(state: BuilderStateModel): boolean {
    return state.membershipsError;
  }

  /** auth/05: the session's active org id (null until chosen). */
  @Selector()
  static activeBuilderId(state: BuilderStateModel): string | null {
    return state.session?.builderId ?? null;
  }

  /** auth/05: the session's active org display name. */
  @Selector()
  static activeBuilderName(state: BuilderStateModel): string | null {
    return state.session?.builderName ?? null;
  }

  /** auth/05: the user's role in the active org. */
  @Selector()
  static activeRole(state: BuilderStateModel): 'builder_admin' | 'builder_member' | null {
    return state.session?.role ?? null;
  }

  /** auth/05: true when the active-org user is a builder_admin. */
  @Selector()
  static isBuilderAdmin(state: BuilderStateModel): boolean {
    return state.session?.role === 'builder_admin';
  }

  @Selector()
  static lastEntraError(state: BuilderStateModel): EntraCallbackErrorKind | null {
    return state.lastEntraError;
  }

  @Selector()
  static leads(state: BuilderStateModel): readonly BuilderLeadListItem[] {
    return state.leads;
  }

  @Selector()
  static summary(state: BuilderStateModel): BuilderLeadListResponse['summary'] {
    return state.summary;
  }

  @Selector()
  static leadsStatus(state: BuilderStateModel): BuilderLeadsStatus {
    return state.leadsStatus;
  }

  @Selector()
  static updatingLeadId(state: BuilderStateModel): string | null {
    return state.updatingLeadId;
  }

  @Selector()
  static updateError(state: BuilderStateModel): string | null {
    return state.updateError;
  }

  /** True when the last lead load failed (network/backend error). */
  @Selector()
  static loadFailed(state: BuilderStateModel): boolean {
    return state.leadsStatus === 'error';
  }

  @Action(LoadBuilderSession)
  loadBuilderSession(ctx: StateContext<BuilderStateModel>): Observable<unknown> {
    return this.authApi.me().pipe(
      tap((identity) => {
        // The /me identity carries no org context (role/builderName are
        // always null there); preserve the previous session's org fields so
        // a session probe doesn't wipe the active org set at sign-in (which
        // hid the Team nav for builder_admins). Backend wins when non-null.
        const prev = ctx.getState().session;
        ctx.patchState({
          session: {
            ...identity,
            builderId: identity.builderId ?? prev?.builderId ?? null,
            builderName: identity.builderName ?? prev?.builderName ?? null,
            role: identity.role ?? prev?.role ?? null,
          },
          authStatus: 'authenticated',
          sessionExpired: false,
          // Keep any memberships the Entra callback already provided;
          // prefer the /me org context when the backend enriches it.
          memberships:
            identity.memberships.length > 0
              ? identity.memberships
              : ctx.getState().memberships,
        });
      }),
      catchError((error: unknown) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code: unknown }).code
            : null;
        ctx.patchState({
          sessionToken: null,
          authStatus: 'unauthenticated',
          session: null,
          sessionExpired: code === 'SESSION_EXPIRED',
          memberships: [],
        });
        return of(null);
      }),
    );
  }

  @Action(CompleteBuilderEntraSignIn)
  completeBuilderEntraSignIn(
    ctx: StateContext<BuilderStateModel>,
    action: CompleteBuilderEntraSignIn,
  ): void {
    ctx.patchState({
      sessionToken: action.sessionToken,
      session: {
        authenticated: true,
        email: action.email,
        name: action.name,
        builderId: null,
        builderName: null,
        role: null,
        memberships: action.memberships,
      },
      memberships: action.memberships,
      authStatus: 'authenticated',
      sessionExpired: false,
      lastEntraError: null,
    });
  }

  @Action(FailBuilderEntraSignIn)
  failBuilderEntraSignIn(
    ctx: StateContext<BuilderStateModel>,
    action: FailBuilderEntraSignIn,
  ): void {
    ctx.patchState({
      sessionToken: null,
      session: null,
      authStatus: 'unauthenticated',
      memberships: [],
      lastEntraError: action.error,
    });
  }

  @Action(SetBuilderActiveOrg)
  setBuilderActiveOrg(
    ctx: StateContext<BuilderStateModel>,
    action: SetBuilderActiveOrg,
  ): void {
    const state = ctx.getState();
    const session = state.session;
    if (!session) return;
    ctx.patchState({
      session: {
        ...session,
        builderId: action.builderId,
        builderName: action.builderName,
        role: action.role,
      },
    });
  }

  @Action(LoadBuilderMemberships)
  loadBuilderMemberships(
    ctx: StateContext<BuilderStateModel>,
  ): Observable<unknown> {
    ctx.patchState({ membershipsLoading: true, membershipsError: false });
    return this.authApi.listMemberships().pipe(
      tap((response) => {
        ctx.patchState({
          memberships: response.memberships,
          membershipsLoading: false,
          membershipsError: false,
        });
      }),
      catchError(() => {
        ctx.patchState({ membershipsLoading: false, membershipsError: true });
        return of(null);
      }),
    );
  }

  @Action(LoadBuilderLeads)
  loadBuilderLeads(ctx: StateContext<BuilderStateModel>): Observable<unknown> {
    ctx.patchState({ leadsStatus: 'loading' });
    return this.leadsApi.listLeads().pipe(
      tap((response) => {
        ctx.patchState({
          leads: response.leads,
          summary: response.summary,
          leadsStatus: 'ready',
        });
      }),
      catchError(() => {
        ctx.patchState({ leadsStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(UpdateBuilderLeadStatus)
  updateBuilderLeadStatus(
    ctx: StateContext<BuilderStateModel>,
    action: UpdateBuilderLeadStatus,
  ): Observable<unknown> {
    ctx.patchState({ updatingLeadId: action.leadId, updateError: null });
    return this.leadsApi.updateStatus(action.leadId, action.status).pipe(
      tap(() => this.applyStatusLocally(ctx, action.leadId, action.status)),
      catchError((error: unknown) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code: unknown }).code
            : null;
        // A 403 means the lead belongs to another tenant (backend-enforced);
        // surface it distinctly so the UI can say so honestly.
        ctx.patchState({
          updatingLeadId: null,
          updateError: code === 'FORBIDDEN' ? 'forbidden' : 'failed',
        });
        return of(null);
      }),
    );
  }

  /**
   * Applies a confirmed status transition locally so the pipeline and the
   * summary stay in sync without a full reload. The backend wrote the
   * timestamp; we stamp `now` for the optimistic row and refresh from the
   * server on the next load.
   */
  private applyStatusLocally(
    ctx: StateContext<BuilderStateModel>,
    leadId: string,
    status: BuilderLeadStatus,
  ): void {
    const state = ctx.getState();
    const now = new Date().toISOString();
    const leads = state.leads.map((lead) =>
      lead.id === leadId ? { ...lead, status, statusUpdatedAt: now } : lead,
    );
    const summary = { ...EMPTY_SUMMARY };
    for (const lead of leads) {
      summary[lead.status] += 1;
    }
    summary.total = leads.length;
    ctx.patchState({ leads, summary, updatingLeadId: null, updateError: null });
  }

  @Action(LogoutBuilder)
  logoutBuilder(ctx: StateContext<BuilderStateModel>): Observable<unknown> {
    return this.authApi.logout().pipe(
      tap((res) => {
        ctx.setState({ ...defaults });
        // Kill the Entra IdP session too (parity with admin logout,
        // logout UX 2026-09-28): without the end-session redirect the
        // Entra cookie survives and the next "Sign in" silently
        // re-authenticates. Null while builder Entra is unprovisioned —
        // then there is no IdP session and this is a no-op.
        this.entraAuth.redirectToEntraLogout(
          res.entraLogoutUrl ?? null,
          res.entraIdTokenHint ?? null,
        );
      }),
      catchError(() => {
        // Even if the server call fails, drop the local session — the
        // guard re-probes on next navigation and fails closed.
        ctx.setState({ ...defaults });
        return of(null);
      }),
    );
  }

  @Action(ClearBuilderState)
  clearBuilderState(ctx: StateContext<BuilderStateModel>): void {
    ctx.setState({ ...defaults });
  }
}
