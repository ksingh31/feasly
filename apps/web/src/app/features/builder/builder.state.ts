import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type {
  BuilderAuthMeResponse,
  BuilderLeadListItem,
  BuilderLeadListResponse,
  BuilderLeadStatus,
} from '@feasly/contracts';
import { BuilderAuthApiService } from './builder-auth-api.service';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import {
  ClearBuilderState,
  LoadBuilderLeads,
  LoadBuilderSession,
  LogoutBuilder,
  UpdateBuilderLeadStatus,
  VerifyBuilderToken,
} from './builder.actions';

/** Auth lifecycle for the builder portal. */
export type BuilderAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

/** Loading lifecycle for the lead pipeline. */
export type BuilderLeadsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BuilderStateModel {
  /** Session identity (email + tenant), memory-only — never persisted. */
  session: BuilderAuthMeResponse | null;
  authStatus: BuilderAuthStatus;
  /** True when the last /me probe failed with SESSION_EXPIRED (login copy). */
  sessionExpired: boolean;
  /** Tenant-scoped leads, memory-only (homeowner PII — never persisted). */
  leads: readonly BuilderLeadListItem[];
  summary: BuilderLeadListResponse['summary'];
  leadsStatus: BuilderLeadsStatus;
  /** Lead id currently being status-updated (disables its action buttons). */
  updatingLeadId: string | null;
  /** Last lead-update failure: 'forbidden' | 'failed' | null. */
  updateError: string | null;
}

const EMPTY_SUMMARY: BuilderLeadListResponse['summary'] = {
  total: 0,
  new: 0,
  contacted: 0,
  quoted: 0,
  won: 0,
  lost: 0,
};

const defaults: BuilderStateModel = {
  session: null,
  authStatus: 'unknown',
  sessionExpired: false,
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
 * The session is cookie-based (HttpOnly `feasly_builder_session`); the store
 * only caches the identity for display. Everything is memory-only: the
 * session and the lead list (homeowner PII) are never written to storage,
 * so this state is deliberately NOT registered with the NGXS storage
 * plugin.
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
  private readonly leadsApi = inject(BuilderLeadsApiService);

  @Selector()
  static session(state: BuilderStateModel): BuilderAuthMeResponse | null {
    return state.session;
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

  @Action(VerifyBuilderToken)
  verifyBuilderToken(
    ctx: StateContext<BuilderStateModel>,
    action: VerifyBuilderToken,
  ): Observable<unknown> {
    return this.authApi.verifyMagicLink(action.token).pipe(
      tap((identity) => {
        ctx.patchState({
          session: {
            authenticated: true,
            email: identity.email,
            tenantKey: identity.tenantKey,
          },
          authStatus: 'authenticated',
          sessionExpired: false,
        });
      }),
      catchError(() => {
        ctx.patchState({ authStatus: 'unauthenticated', session: null });
        return of(null);
      }),
    );
  }

  @Action(LoadBuilderSession)
  loadBuilderSession(ctx: StateContext<BuilderStateModel>): Observable<unknown> {
    return this.authApi.me().pipe(
      tap((identity) => {
        ctx.patchState({
          session: identity,
          authStatus: 'authenticated',
          sessionExpired: false,
        });
      }),
      catchError((error: unknown) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code: unknown }).code
            : null;
        ctx.patchState({
          authStatus: 'unauthenticated',
          session: null,
          sessionExpired: code === 'SESSION_EXPIRED',
        });
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
      tap(() => ctx.setState({ ...defaults })),
      catchError(() => {
        // Even if the server call fails, drop the local session — the
        // cookie is HttpOnly and the guard re-probes on next navigation.
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
