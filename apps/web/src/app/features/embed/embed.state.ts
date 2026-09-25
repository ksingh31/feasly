import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { catchError, map } from 'rxjs';
import type { EmbedPublicConfig } from '@feasly/contracts';
import type { ApiError } from '@feasly/contracts';
import { EmbedConfigFailed, EmbedConfigLoaded, LoadEmbedConfig } from './embed.actions';
import { EmbedConfigService } from './embed-config.service';

/** Embed shell lifecycle (EMB-01). */
export type EmbedStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface EmbedStateModel {
  /** Tenant key from the URL (`?key=` or `:tenantKey`). Null until resolved. */
  tenantKey: string | null;
  /** Builder config from EMB-02. Null until loaded. */
  config: EmbedPublicConfig | null;
  status: EmbedStatus;
  /** Machine-readable failure code (unknown_tenant, http_0, …). Never user-facing. */
  error: string | null;
}

/**
 * Embed state (EMB-01): the single source of truth for the white-label
 * shell. Session-scoped — deliberately NOT in the storage-plugin keys, so
 * a stale builder config can never leak across tenants or visits. The
 * config is re-fetched from `?key=` on every load.
 */
@State<EmbedStateModel>({
  name: 'embed',
  defaults: {
    tenantKey: null,
    config: null,
    status: 'idle',
    error: null,
  },
})
@Injectable()
export class EmbedState {
  private readonly configs = inject(EmbedConfigService);

  @Selector()
  static status(state: EmbedStateModel): EmbedStatus {
    return state.status;
  }

  @Selector()
  static config(state: EmbedStateModel): EmbedPublicConfig | null {
    return state.config;
  }

  @Selector()
  static tenantKey(state: EmbedStateModel): string | null {
    return state.tenantKey;
  }

  @Action(LoadEmbedConfig)
  load(ctx: StateContext<EmbedStateModel>, action: LoadEmbedConfig) {
    ctx.patchState({ tenantKey: action.tenantKey, config: null, status: 'loading', error: null });
    return this.configs.getConfig(action.tenantKey).pipe(
      map((config) => ctx.dispatch(new EmbedConfigLoaded(config))),
      // ctx.dispatch() already returns an observable — return it directly.
      catchError((err: unknown) =>
        ctx.dispatch(
          new EmbedConfigFailed(
            typeof (err as ApiError)?.code === 'string' ? (err as ApiError).code : 'unknown',
          ),
        ),
      ),
    );
  }

  @Action(EmbedConfigLoaded)
  loaded(ctx: StateContext<EmbedStateModel>, action: EmbedConfigLoaded) {
    ctx.patchState({ config: action.config, status: 'ready', error: null });
  }

  @Action(EmbedConfigFailed)
  failed(ctx: StateContext<EmbedStateModel>, action: EmbedConfigFailed) {
    ctx.patchState({ config: null, status: 'error', error: action.reason });
  }
}
