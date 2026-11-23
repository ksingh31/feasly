import { inject, Injectable, type EnvironmentProviders } from '@angular/core';
import { Action, provideStates, Selector, State, type StateContext } from '@ngxs/store';
import { catchError, map, of, switchMap } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AddressSchoolDesignationsResponse, CommunityLivingResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { LoadReportNeighbourhood } from './report-neighbourhood.actions';

export type ReportNeighbourhoodStatus = 'idle' | 'loading' | 'ready';

/**
 * Report neighbourhood sections (#785). Memory-only (never persisted): the
 * data is free, ungated, and re-read from the API's stored tables — the API
 * never calls an outside source on a visit. A failed read leaves the
 * matching section empty, and an empty section hides (no empty boxes).
 */
export interface ReportNeighbourhoodModel {
  /** Address the data below belongs to. */
  addressKey: string | null;
  status: ReportNeighbourhoodStatus;
  schools: AddressSchoolDesignationsResponse | null;
  living: CommunityLivingResponse | null;
}

const defaults: ReportNeighbourhoodModel = {
  addressKey: null,
  status: 'idle',
  schools: null,
  living: null,
};

@State<ReportNeighbourhoodModel>({ name: 'reportNeighbourhood', defaults })
@Injectable()
export class ReportNeighbourhoodState {
  private readonly api = inject(API_SERVICE);

  @Selector()
  static status(state: ReportNeighbourhoodModel): ReportNeighbourhoodStatus {
    return state.status;
  }

  @Selector()
  static schools(state: ReportNeighbourhoodModel): AddressSchoolDesignationsResponse | null {
    return state.schools;
  }

  @Selector()
  static living(state: ReportNeighbourhoodModel): CommunityLivingResponse | null {
    return state.living;
  }

  /**
   * Designations first (they resolve the address's community), then that
   * community's living metrics. A newer address cancels an in-flight load;
   * the same address again is a no-op (one request per address).
   */
  @Action(LoadReportNeighbourhood, { cancelUncompleted: true })
  load(ctx: StateContext<ReportNeighbourhoodModel>, { addressKey }: LoadReportNeighbourhood): Observable<void> {
    const current = ctx.getState();
    if (current.addressKey === addressKey && current.status !== 'idle') return of(undefined);
    ctx.setState({ addressKey, status: 'loading', schools: null, living: null });
    return this.api.getAddressSchoolDesignations(addressKey).pipe(
      catchError(() => of(null)),
      switchMap((schools) => {
        ctx.patchState({ schools });
        const slug = schools?.slug ?? null;
        if (!slug) return of(null);
        return this.api.getCommunityLiving(slug).pipe(catchError(() => of(null)));
      }),
      map((living) => {
        ctx.patchState({ living, status: 'ready' });
      }),
    );
  }
}

/** Lazy provider for `/estimate/report` (app.routes.ts lazyProvider). */
export const reportNeighbourhoodStateProvider: EnvironmentProviders = provideStates([ReportNeighbourhoodState]);
