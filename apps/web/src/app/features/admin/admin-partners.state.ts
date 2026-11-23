import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { catchError, concatMap, finalize, from, last, of, tap, throwError } from 'rxjs';
import type { AdminBuilderPartner } from '@feasly/contracts';
import { AdminPartnersApiService } from './admin-partners-api.service';
import {
  ClearAdminPartnerSaveError,
  CreateAdminPartner,
  LoadAdminPartners,
  MoveAdminPartner,
  SetAdminPartnerActive,
  UpdateAdminPartner,
} from './admin-partners.actions';

export type AdminPartnersLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AdminPartnersStateModel {
  partners: readonly AdminBuilderPartner[];
  loadStatus: AdminPartnersLoadStatus;
  /** Load failure message. */
  loadError: string | null;
  /** A drawer create/update is in flight. */
  saving: boolean;
  /** Drawer save failure (the backend's message), shown inside the drawer. */
  saveError: string | null;
  /** The row an activate/reorder request is running for, or null. */
  busyId: string | null;
}

const defaults: AdminPartnersStateModel = {
  partners: [],
  loadStatus: 'idle',
  loadError: null,
  saving: false,
  saveError: null,
  busyId: null,
};

type ErrorLike = { message?: string } | null | undefined;

/** Display order first, then name — the same order as the public list. */
function sortPartners(partners: readonly AdminBuilderPartner[]): AdminBuilderPartner[] {
  return [...partners].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name),
  );
}

function replace(
  partners: readonly AdminBuilderPartner[],
  updated: AdminBuilderPartner,
): AdminBuilderPartner[] {
  const exists = partners.some((p) => p.id === updated.id);
  return sortPartners(
    exists ? partners.map((p) => (p.id === updated.id ? updated : p)) : [...partners, updated],
  );
}

/**
 * Admin builder partners (#919): the single source of truth for
 * `/admin/partners`, on top of the #896 admin CRUD API.
 *
 * Handlers return their API observables so NGXS owns the subscription.
 * Write failures are stored for the UI AND re-thrown so the dispatching
 * component can keep its drawer open / show an error toast. Memory-only:
 * never added to the storage plugin.
 */
@State<AdminPartnersStateModel>({ name: 'adminPartners', defaults })
@Injectable()
export class AdminPartnersState {
  private readonly api = inject(AdminPartnersApiService);

  @Selector()
  static partners(state: AdminPartnersStateModel): readonly AdminBuilderPartner[] {
    return state.partners;
  }

  @Selector()
  static loadStatus(state: AdminPartnersStateModel): AdminPartnersLoadStatus {
    return state.loadStatus;
  }

  @Selector()
  static loadError(state: AdminPartnersStateModel): string | null {
    return state.loadError;
  }

  @Selector()
  static saving(state: AdminPartnersStateModel): boolean {
    return state.saving;
  }

  @Selector()
  static saveError(state: AdminPartnersStateModel): string | null {
    return state.saveError;
  }

  @Selector()
  static busyId(state: AdminPartnersStateModel): string | null {
    return state.busyId;
  }

  @Action(LoadAdminPartners, { cancelUncompleted: true })
  load(ctx: StateContext<AdminPartnersStateModel>) {
    ctx.patchState({ loadStatus: 'loading', loadError: null });
    return this.api.listPartners().pipe(
      tap((res) =>
        ctx.patchState({ partners: sortPartners(res.partners), loadStatus: 'ready' }),
      ),
      catchError((err: ErrorLike) => {
        ctx.patchState({
          loadStatus: 'error',
          loadError: err?.message ?? 'Could not load the partners. Try again.',
        });
        return of(null);
      }),
    );
  }

  @Action(ClearAdminPartnerSaveError)
  clearSaveError(ctx: StateContext<AdminPartnersStateModel>) {
    ctx.patchState({ saveError: null });
  }

  @Action(CreateAdminPartner)
  create(ctx: StateContext<AdminPartnersStateModel>, action: CreateAdminPartner) {
    ctx.patchState({ saving: true, saveError: null });
    return this.api.createPartner(action.body).pipe(
      tap((partner) =>
        ctx.patchState({ partners: replace(ctx.getState().partners, partner), saving: false }),
      ),
      catchError((err: ErrorLike) => {
        ctx.patchState({
          saving: false,
          saveError: err?.message ?? 'Could not add the partner. Try again.',
        });
        return throwError(() => err);
      }),
    );
  }

  @Action(UpdateAdminPartner)
  update(ctx: StateContext<AdminPartnersStateModel>, action: UpdateAdminPartner) {
    ctx.patchState({ saving: true, saveError: null });
    return this.api.updatePartner(action.id, action.body).pipe(
      tap((partner) =>
        ctx.patchState({ partners: replace(ctx.getState().partners, partner), saving: false }),
      ),
      catchError((err: ErrorLike) => {
        ctx.patchState({
          saving: false,
          saveError: err?.message ?? 'Could not save the partner. Try again.',
        });
        return throwError(() => err);
      }),
    );
  }

  @Action(SetAdminPartnerActive)
  setActive(ctx: StateContext<AdminPartnersStateModel>, action: SetAdminPartnerActive) {
    ctx.patchState({ busyId: action.id });
    return this.api.updatePartner(action.id, { active: action.active }).pipe(
      tap((partner) => ctx.patchState({ partners: replace(ctx.getState().partners, partner) })),
      finalize(() => ctx.patchState({ busyId: null })),
    );
  }

  /**
   * Reorder: move the row one place, then renumber the whole list 0…n-1 and
   * PATCH only the partners whose `displayOrder` changed (one at a time).
   * Renumbering keeps the order well-defined when several partners share a
   * display order. The list reloads afterwards — on failure too, so the
   * table always shows what the server holds.
   */
  @Action(MoveAdminPartner)
  move(ctx: StateContext<AdminPartnersStateModel>, action: MoveAdminPartner) {
    const current = ctx.getState().partners;
    const index = current.findIndex((p) => p.id === action.id);
    const target = index + action.direction;
    if (index < 0 || target < 0 || target >= current.length || ctx.getState().busyId) {
      return undefined;
    }
    const reordered = [...current];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    const changes = reordered
      .map((partner, displayOrder) => ({ partner, displayOrder }))
      .filter(({ partner, displayOrder }) => partner.displayOrder !== displayOrder);

    ctx.patchState({ busyId: action.id });
    return from(changes).pipe(
      concatMap(({ partner, displayOrder }) =>
        this.api.updatePartner(partner.id, { displayOrder }),
      ),
      last(null, null),
      finalize(() => {
        ctx.patchState({ busyId: null });
        ctx.dispatch(new LoadAdminPartners());
      }),
    );
  }
}

/** Route-level provider, registered via `lazyProvider` in `app.routes.ts`. */
export const adminPartnersStateProvider = provideStates([AdminPartnersState]);
