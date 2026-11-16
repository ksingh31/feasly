import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { EMPTY, timer } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type {
  ApiError,
  Builder,
  BuilderExportKind,
  BuilderLifecycleResponse,
  BuilderListResponse,
  BuilderOffboardingBlocker,
  BuilderOffboardingBlockersResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { LIFECYCLE_ACTION_VIEWS } from './admin-builders-view';
import {
  AssignLeadBuilder,
  ChangeBuilderStatus,
  CreateBuilder,
  DismissBuilderExportError,
  DismissBuilderLifecycleFeedback,
  ExportBuilderData,
  LoadOffboardingBlockers,
  DismissAssignBuilderError,
  DismissAssignBuilderSuccess,
  DismissBuildersError,
  DismissBuildersSaved,
  DismissBuildersSaveError,
  LoadBuilders,
  UpdateBuilder,
} from './admin-builders.actions';

/** Builders table loading lifecycle. */
export type AdminBuildersStatus = 'idle' | 'loading' | 'error';

/** Result of the last lifecycle action (#861), read once by the modal. */
export type BuilderLifecycleFeedback =
  | { readonly ok: true; readonly message: string }
  | {
      readonly ok: false;
      readonly message: string;
      /** 409 OFFBOARDING_BLOCKED: the checklist reloads its blockers. */
      readonly blocked: boolean;
    };

/** Offboarding blockers for the builder open in the drawer (#861). */
export interface OffboardingBlockersModel {
  readonly builderId: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly BuilderOffboardingBlocker[];
  readonly error: string | null;
}

const NO_BLOCKERS: OffboardingBlockersModel = {
  builderId: null,
  status: 'idle',
  items: [],
  error: null,
};

export interface AdminBuildersStateModel {
  /** Builder rows, in the order the backend returned them. */
  builders: Builder[];
  listStatus: AdminBuildersStatus;
  listError: string | null;
  /** Create/update in flight. */
  saving: boolean;
  /** Last failed save message; null when the last save succeeded. */
  saveError: string | null;
  /** True after a create/update until dismissed (drives the "saved" banner). */
  saved: boolean;
  /** Assign-to-builder in flight (lead detail dropdown). */
  assigning: boolean;
  /** Last failed assign message; null when the last assign succeeded. */
  assignError: string | null;
  /** True after an assign until dismissed (drives the inline confirmation). */
  assignSuccess: boolean;
  /** A lifecycle action is in flight (#861). */
  lifecycleBusy: boolean;
  /** Last lifecycle result until dismissed. */
  lifecycleFeedback: BuilderLifecycleFeedback | null;
  /** Offboarding checklist blockers (#861). */
  blockers: OffboardingBlockersModel;
  /** Which export is downloading, if any (#861). */
  exporting: BuilderExportKind | null;
  /** Last failed export message. */
  exportError: string | null;
}

const defaults: AdminBuildersStateModel = {
  builders: [],
  listStatus: 'idle',
  listError: null,
  saving: false,
  saveError: null,
  saved: false,
  assigning: false,
  assignError: null,
  assignSuccess: false,
  lifecycleBusy: false,
  lifecycleFeedback: null,
  blockers: NO_BLOCKERS,
  exporting: null,
  exportError: null,
};

/**
 * Admin builders-management state (embed/02 admin-UI migration).
 *
 * Memory-only — deliberately NOT registered with the storage plugin:
 * builder rows refetch cheaply on mount and must never go stale.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription, so a newer `LoadBuilders` cancels an
 * in-flight load and no stale response can overwrite a newer result.
 */
@State<AdminBuildersStateModel>({
  name: 'adminBuilders',
  defaults,
})
@Injectable()
export class AdminBuildersState {
  private readonly api = inject(AdminBuildersApiService);
  private readonly document = inject(DOCUMENT);
  private readonly config = inject(ConfigService);

  // ------------------------------------------------------------------ selectors

  @Selector()
  static builders(state: AdminBuildersStateModel): Builder[] {
    return state.builders;
  }

  @Selector()
  static listStatus(state: AdminBuildersStateModel): AdminBuildersStatus {
    return state.listStatus;
  }

  @Selector()
  static listError(state: AdminBuildersStateModel): string | null {
    return state.listError;
  }

  @Selector()
  static saving(state: AdminBuildersStateModel): boolean {
    return state.saving;
  }

  @Selector()
  static saveError(state: AdminBuildersStateModel): string | null {
    return state.saveError;
  }

  @Selector()
  static saved(state: AdminBuildersStateModel): boolean {
    return state.saved;
  }

  @Selector()
  static assigning(state: AdminBuildersStateModel): boolean {
    return state.assigning;
  }

  @Selector()
  static assignError(state: AdminBuildersStateModel): string | null {
    return state.assignError;
  }

  @Selector()
  static assignSuccess(state: AdminBuildersStateModel): boolean {
    return state.assignSuccess;
  }

  @Selector()
  static lifecycleBusy(state: AdminBuildersStateModel): boolean {
    return state.lifecycleBusy;
  }

  @Selector()
  static lifecycleFeedback(state: AdminBuildersStateModel): BuilderLifecycleFeedback | null {
    return state.lifecycleFeedback;
  }

  @Selector()
  static blockers(state: AdminBuildersStateModel): OffboardingBlockersModel {
    return state.blockers;
  }

  @Selector()
  static exporting(state: AdminBuildersStateModel): BuilderExportKind | null {
    return state.exporting;
  }

  @Selector()
  static exportError(state: AdminBuildersStateModel): string | null {
    return state.exportError;
  }

  // ------------------------------------------------------------------ actions

  @Action(LoadBuilders)
  load(ctx: StateContext<AdminBuildersStateModel>): Observable<BuilderListResponse> {
    ctx.patchState({ listStatus: 'loading', listError: null });
    return this.api.listBuilders().pipe(
      tap({
        next: (res) => {
          ctx.patchState({
            builders: [...res.builders],
            listStatus: 'idle',
            listError: null,
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            listStatus: 'error',
            listError: err?.message ?? 'Could not load builders. Please try again.',
          });
        },
      }),
    );
  }

  @Action(CreateBuilder)
  create(
    ctx: StateContext<AdminBuildersStateModel>,
    action: CreateBuilder,
  ): Observable<Builder> {
    ctx.patchState({ saving: true, saveError: null, saved: false });
    return this.api.createBuilder(action.body).pipe(
      tap({
        next: (builder) => {
          const state = ctx.getState();
          ctx.patchState({
            saving: false,
            saveError: null,
            saved: true,
            builders: [...state.builders, builder],
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            saving: false,
            saved: false,
            saveError: err?.message ?? 'Could not add the builder. Please try again.',
          });
        },
      }),
    );
  }

  @Action(UpdateBuilder)
  update(
    ctx: StateContext<AdminBuildersStateModel>,
    action: UpdateBuilder,
  ): Observable<Builder> {
    ctx.patchState({ saving: true, saveError: null, saved: false });
    return this.api.updateBuilder(action.id, action.body).pipe(
      tap({
        next: (builder) => {
          const state = ctx.getState();
          ctx.patchState({
            saving: false,
            saveError: null,
            saved: true,
            builders: state.builders.map((b) => (b.id === action.id ? builder : b)),
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            saving: false,
            saved: false,
            saveError: err?.message ?? 'Could not save the builder. Please try again.',
          });
        },
      }),
    );
  }

  @Action(AssignLeadBuilder)
  assign(
    ctx: StateContext<AdminBuildersStateModel>,
    action: AssignLeadBuilder,
  ): Observable<{ ok: true }> {
    ctx.patchState({ assigning: true, assignError: null, assignSuccess: false });
    return this.api.assignLeadBuilder(action.leadId, action.builderId).pipe(
      tap({
        next: () => {
          ctx.patchState({ assigning: false, assignError: null, assignSuccess: true });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            assigning: false,
            assignError:
              err?.message ?? 'Could not assign the lead. Please try again.',
            assignSuccess: false,
          });
        },
      }),
    );
  }

  /**
   * #861: lifecycle action. Errors are swallowed into `lifecycleFeedback`
   * (never thrown through the dispatch — that would land on /error).
   */
  @Action(ChangeBuilderStatus)
  changeStatus(
    ctx: StateContext<AdminBuildersStateModel>,
    action: ChangeBuilderStatus,
  ): Observable<BuilderLifecycleResponse> | void {
    if (ctx.getState().lifecycleBusy) return;
    ctx.patchState({ lifecycleBusy: true, lifecycleFeedback: null });
    return this.api.changeStatus(action.id, { action: action.action, reason: action.reason.trim() }).pipe(
      tap((res) => {
        const state = ctx.getState();
        ctx.patchState({
          lifecycleBusy: false,
          lifecycleFeedback: { ok: true, message: LIFECYCLE_ACTION_VIEWS[action.action].done },
          builders: state.builders.map((b) => (b.id === action.id ? res.builder : b)),
        });
      }),
      catchError((err: Partial<ApiError>) => {
        ctx.patchState({
          lifecycleBusy: false,
          lifecycleFeedback: {
            ok: false,
            message: err?.message ?? 'Could not change the builder status. Please try again.',
            blocked: err?.code === 'OFFBOARDING_BLOCKED',
          },
        });
        return EMPTY;
      }),
    );
  }

  @Action(DismissBuilderLifecycleFeedback)
  dismissLifecycleFeedback(ctx: StateContext<AdminBuildersStateModel>): void {
    ctx.patchState({ lifecycleFeedback: null });
  }

  /** #861 checklist: what blocks "complete offboarding" right now. */
  @Action(LoadOffboardingBlockers, { cancelUncompleted: true })
  loadBlockers(
    ctx: StateContext<AdminBuildersStateModel>,
    action: LoadOffboardingBlockers,
  ): Observable<BuilderOffboardingBlockersResponse> {
    const keep = ctx.getState().blockers.builderId === action.id ? ctx.getState().blockers.items : [];
    ctx.patchState({ blockers: { builderId: action.id, status: 'loading', items: keep, error: null } });
    return this.api.offboardingBlockers(action.id).pipe(
      tap((res) => {
        ctx.patchState({
          blockers: { builderId: action.id, status: 'ready', items: [...res.blockers], error: null },
        });
      }),
      catchError((err: Partial<ApiError>) => {
        ctx.patchState({
          blockers: {
            builderId: action.id,
            status: 'error',
            items: [],
            error: err?.message ?? 'Could not load the checklist. Please try again.',
          },
        });
        return EMPTY;
      }),
    );
  }

  /** #861 hand-over export: download one builder's leads or invoices CSV. */
  @Action(ExportBuilderData)
  exportData(
    ctx: StateContext<AdminBuildersStateModel>,
    action: ExportBuilderData,
  ): Observable<Blob> | void {
    if (ctx.getState().exporting !== null) return;
    ctx.patchState({ exporting: action.kind, exportError: null });
    const builder = ctx.getState().builders.find((b) => b.id === action.id);
    const filename = `${builder?.tenantKey ?? 'builder'}-${action.kind}.csv`;
    return this.api.exportCsv(action.id, action.kind).pipe(
      tap((blob) => {
        ctx.patchState({ exporting: null });
        this.downloadBlob(blob, filename);
      }),
      catchError((err: Partial<ApiError>) => {
        ctx.patchState({
          exporting: null,
          exportError: err?.message ?? 'Could not export the CSV. Please try again.',
        });
        return EMPTY;
      }),
    );
  }

  @Action(DismissBuilderExportError)
  dismissExportError(ctx: StateContext<AdminBuildersStateModel>): void {
    ctx.patchState({ exportError: null });
  }

  @Action(DismissBuildersError)
  dismissListError(ctx: StateContext<AdminBuildersStateModel>): void {
    ctx.patchState({ listError: null, listStatus: 'idle' });
  }

  @Action(DismissBuildersSaveError)
  dismissSaveError(ctx: StateContext<AdminBuildersStateModel>): void {
    ctx.patchState({ saveError: null });
  }

  @Action(DismissBuildersSaved)
  dismissSaved(ctx: StateContext<AdminBuildersStateModel>): void {
    ctx.patchState({ saved: false });
  }

  @Action(DismissAssignBuilderError)
  dismissAssignError(ctx: StateContext<AdminBuildersStateModel>): void {
    ctx.patchState({ assignError: null });
  }

  @Action(DismissAssignBuilderSuccess)
  dismissAssignSuccess(ctx: StateContext<AdminBuildersStateModel>): void {
    ctx.patchState({ assignSuccess: false });
  }

  /**
   * Trigger the browser download. The object URL is revoked on a delay —
   * revoking in the same task aborts the download in Safari (same as the
   * leads export).
   */
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = this.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    this.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    timer(this.config.get('api').downloadRevokeDelayMs).subscribe(() => URL.revokeObjectURL(url));
  }
}

/**
 * Route-level provider for the `/admin` route.
 * Registered via `lazyProvider` in `app.routes.ts` with a dynamic import so
 * the state + its actions stay in the admin lazy chunk, out of the
 * initial bundle (790kB production budget). Registered on the `/admin`
 * PARENT route (not the `builders` child) because the lead-detail modal —
 * rendered under `/admin/leads` — needs the builders list for its
 * assign-to-builder dropdown.
 */
export const adminBuildersStateProvider = provideStates([AdminBuildersState]);
