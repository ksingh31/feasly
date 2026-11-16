import { isPlatformServer } from '@angular/common';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { catchError, EMPTY, tap } from 'rxjs';
import type { Observable } from 'rxjs';
import type { BuilderPartner, BuilderPartnerListResponse } from '@feasly/contracts';
import { API_SERVICE } from '../api/api.service';
import { LoadPartners } from './partners.actions';

export type PartnersStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Builder partner disclosure state (#918). The partner list is data from
 * `GET /api/v1/partners`, shared by every own-site lead capture point (lead
 * gate, report callback) and the How it works partners section.
 *
 * Fetched at most once per session (cached in memory, never persisted —
 * admins can change it, and the API serves it with Cache-Control). Never
 * fetched during prerender/SSR: the browser loads it after hydration.
 */
export interface PartnersStateModel {
  readonly status: PartnersStatus;
  readonly partners: readonly BuilderPartner[];
}

const defaults: PartnersStateModel = { status: 'idle', partners: [] };

@State<PartnersStateModel>({ name: 'partners', defaults })
@Injectable()
export class PartnersState {
  private readonly api = inject(API_SERVICE);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));

  @Selector()
  static status(state: PartnersStateModel): PartnersStatus {
    return state.status;
  }

  @Selector()
  static partners(state: PartnersStateModel): readonly BuilderPartner[] {
    return state.partners;
  }

  @Action(LoadPartners)
  load(ctx: StateContext<PartnersStateModel>): Observable<BuilderPartnerListResponse> | void {
    const { status } = ctx.getState();
    if (this.isServer || status === 'loading' || status === 'ready') return;
    ctx.patchState({ status: 'loading' });
    return this.api.getPartners().pipe(
      tap((res) => ctx.setState({ status: 'ready', partners: res.partners })),
      catchError(() => {
        ctx.patchState({ status: 'error' });
        return EMPTY;
      }),
    );
  }
}
