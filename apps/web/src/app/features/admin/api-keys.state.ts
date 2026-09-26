import { Injectable, inject } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { tap } from 'rxjs';
import type {
  ApiKeyRecordResponse,
} from '@feasly/contracts';
import {
  API_SERVICE,
  type ApiKeyUsageAggregate,
} from '../../core/api/api.service';
import {
  ClearPlaintext,
  IssueApiKey,
  LoadApiKeyUsage,
  LoadApiKeys,
  RevokeApiKey,
  RotateApiKey,
  SelectApiKey,
  UpdateApiKey,
} from './api-keys.actions';

export interface ApiKeysStateModel {
  /** Key list (masked prefixes only — never plaintext). */
  keys: readonly ApiKeyRecordResponse[];
  /** True while the list is loading. */
  loading: boolean;
  /** Load failure flag. */
  loadFailed: boolean;
  /** Currently selected key ID (detail panel + usage). */
  selectedId: string | null;
  /**
   * Once-only plaintext from the last issue/rotate. Cleared on navigation —
   * the backend never returns it again.
   */
  plaintext: string | null;
  /** The key record the plaintext belongs to (for the "new key" banner). */
  plaintextKey: ApiKeyRecordResponse | null;
  /** True while an issue/rotate/revoke/update is in flight. */
  mutating: boolean;
  /** Per-day usage for the selected key. */
  usage: readonly ApiKeyUsageAggregate[];
  /** True while usage is loading. */
  usageLoading: boolean;
}

const defaults: ApiKeysStateModel = {
  keys: [],
  loading: false,
  loadFailed: false,
  selectedId: null,
  plaintext: null,
  plaintextKey: null,
  mutating: false,
  usage: [],
  usageLoading: false,
};

/**
 * API key management state (story api-mcp/02).
 *
 * Not persisted (storage-plugin): the key list is refetched on page entry,
 * and the once-only plaintext must never survive a refresh — navigating
 * away loses it permanently, per the acceptance criteria.
 */
@State<ApiKeysStateModel>({
  name: 'apiKeys',
  defaults,
})
@Injectable()
export class ApiKeysState {
  private readonly api = inject(API_SERVICE);

  @Selector()
  static keys(state: ApiKeysStateModel): readonly ApiKeyRecordResponse[] {
    return state.keys;
  }

  @Selector()
  static selected(
    state: ApiKeysStateModel,
  ): ApiKeyRecordResponse | null {
    return state.keys.find((k) => k.id === state.selectedId) ?? null;
  }

  @Selector()
  static plaintext(state: ApiKeysStateModel): string | null {
    return state.plaintext;
  }

  @Selector()
  static usage(state: ApiKeysStateModel): readonly ApiKeyUsageAggregate[] {
    return state.usage;
  }

  @Selector()
  static usageLoading(state: ApiKeysStateModel): boolean {
    return state.usageLoading;
  }

  @Selector()
  static loadFailed(state: ApiKeysStateModel): boolean {
    return state.loadFailed;
  }

  @Selector()
  static loading(state: ApiKeysStateModel): boolean {
    return state.loading;
  }

  @Action(LoadApiKeys)
  load(ctx: StateContext<ApiKeysStateModel>) {
    ctx.patchState({ loading: true, loadFailed: false });
    return this.api.listApiKeys().pipe(
      tap({
        next: (res) =>
          ctx.patchState({ keys: res.keys, loading: false }),
        error: () => ctx.patchState({ loading: false, loadFailed: true }),
      }),
    );
  }

  @Action(IssueApiKey)
  issue(ctx: StateContext<ApiKeysStateModel>, action: IssueApiKey) {
    ctx.patchState({ mutating: true });
    return this.api.issueApiKey(action.request).pipe(
      tap({
        next: (res) => {
          const keys = [res.key, ...ctx.getState().keys];
          ctx.patchState({
            keys,
            mutating: false,
            plaintext: res.plaintext,
            plaintextKey: res.key,
            selectedId: res.key.id,
          });
        },
        error: () => ctx.patchState({ mutating: false }),
      }),
    );
  }

  @Action(RotateApiKey)
  rotate(ctx: StateContext<ApiKeysStateModel>, action: RotateApiKey) {
    ctx.patchState({ mutating: true });
    return this.api.rotateApiKey(action.id).pipe(
      tap({
        next: (res) => {
          // The old key is revoked — drop it, prepend the new one.
          const keys = [
            res.key,
            ...ctx.getState().keys.filter((k) => k.id !== action.id),
          ];
          ctx.patchState({
            keys,
            mutating: false,
            plaintext: res.plaintext,
            plaintextKey: res.key,
            selectedId: res.key.id,
          });
        },
        error: () => ctx.patchState({ mutating: false }),
      }),
    );
  }

  @Action(RevokeApiKey)
  revoke(ctx: StateContext<ApiKeysStateModel>, action: RevokeApiKey) {
    ctx.patchState({ mutating: true });
    return this.api.revokeApiKey(action.id).pipe(
      tap({
        next: () => {
          const state = ctx.getState();
          ctx.patchState({
            keys: state.keys.filter((k) => k.id !== action.id),
            mutating: false,
            selectedId:
              state.selectedId === action.id ? null : state.selectedId,
          });
        },
        error: () => ctx.patchState({ mutating: false }),
      }),
    );
  }

  @Action(UpdateApiKey)
  update(ctx: StateContext<ApiKeysStateModel>, action: UpdateApiKey) {
    ctx.patchState({ mutating: true });
    return this.api.updateApiKey(action.id, action.patch).pipe(
      tap({
        next: (updated) => {
          const keys = ctx
            .getState()
            .keys.map((k) => (k.id === action.id ? updated : k));
          ctx.patchState({ keys, mutating: false });
        },
        error: () => ctx.patchState({ mutating: false }),
      }),
    );
  }

  @Action(SelectApiKey)
  select(ctx: StateContext<ApiKeysStateModel>, action: SelectApiKey) {
    ctx.patchState({
      selectedId: action.id,
      usage: [],
    });
  }

  @Action(ClearPlaintext)
  clearPlaintext(ctx: StateContext<ApiKeysStateModel>) {
    ctx.patchState({ plaintext: null, plaintextKey: null });
  }

  @Action(LoadApiKeyUsage)
  loadUsage(ctx: StateContext<ApiKeysStateModel>, action: LoadApiKeyUsage) {
    ctx.patchState({ usageLoading: true, usage: [] });
    return this.api.getApiKeyUsage(action.id).pipe(
      tap({
        next: (usage) => ctx.patchState({ usage, usageLoading: false }),
        error: () => ctx.patchState({ usageLoading: false }),
      }),
    );
  }
}
