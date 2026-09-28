import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { Builder, BuilderListResponse } from '@feasly/contracts';
import { AdminBuildersApiService } from './admin-builders-api.service';
import {
  AssignLeadBuilder,
  CreateBuilder,
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
