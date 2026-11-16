import {
  inject,
  Injectable,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import type {
  BuilderEmbedResponse,
  BuilderNotificationPreferencesResponse,
  BuilderNotificationPreferencesUpdateBody,
  BuilderOriginRequestBody,
  BuilderProfile,
  BuilderProfileUpdateBody,
  BuilderSupportContact,
} from '@feasly/contracts';
import { BuilderSettingsApiService } from './builder-settings-api.service';
import { provideBuilderCopy } from './builder-copy';

/** Load profile & branding + support contact. */
export class LoadBuilderProfile {
  static readonly type = '[BuilderSettings] Load profile';
}

/** Save profile & branding (org owners only; the API enforces it too). */
export class SaveBuilderProfile {
  static readonly type = '[BuilderSettings] Save profile';
  constructor(public readonly body: BuilderProfileUpdateBody) {}
}

/** Load the embed snippet + per-origin install check. */
export class LoadBuilderEmbed {
  static readonly type = '[BuilderSettings] Load embed';
}

/** File a "Request a change" for allowed origins (opens an admin task). */
export class RequestBuilderOriginChange {
  static readonly type = '[BuilderSettings] Request origin change';
  constructor(public readonly body: BuilderOriginRequestBody) {}
}

/** Load the signed-in member's email notification preferences (#864). */
export class LoadBuilderNotificationPreferences {
  static readonly type = '[BuilderSettings] Load notification preferences';
}

/** Save a (partial) notification preferences change (#864). */
export class SaveBuilderNotificationPreferences {
  static readonly type = '[BuilderSettings] Save notification preferences';
  constructor(public readonly body: BuilderNotificationPreferencesUpdateBody) {}
}

/** Clear the last save / request error. */
export class ClearBuilderSettingsErrors {
  static readonly type = '[BuilderSettings] Clear errors';
}

export type BuilderSettingsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Outcome of the last origin-change request. */
export type BuilderOriginRequestOutcome = 'created' | 'duplicate' | null;

export interface BuilderSettingsStateModel {
  profile: BuilderProfile | null;
  /** True when the caller may edit (owner, not viewing as a teammate). */
  canEdit: boolean;
  support: BuilderSupportContact | null;
  profileStatus: BuilderSettingsLoadStatus;
  /** Save in flight (busy guard). */
  saving: boolean;
  /** The API's message for the last failed save; '' = failed, no message. */
  saveError: string | null;
  embed: BuilderEmbedResponse | null;
  embedStatus: BuilderSettingsLoadStatus;
  /** Origin-change request in flight (busy guard). */
  requesting: boolean;
  /** The API's message for the last failed request; '' = failed, no message. */
  requestError: string | null;
  requestOutcome: BuilderOriginRequestOutcome;
  /** #864: email notification preferences (null until loaded). */
  notifications: BuilderNotificationPreferencesResponse | null;
  notificationsStatus: BuilderSettingsLoadStatus;
  /** Preferences save in flight (busy guard). */
  notificationsSaving: boolean;
  /** The API's message for the last failed save (409/403…); '' = no message. */
  notificationsError: string | null;
}

const defaults: BuilderSettingsStateModel = {
  profile: null,
  canEdit: false,
  support: null,
  profileStatus: 'idle',
  saving: false,
  saveError: null,
  embed: null,
  embedStatus: 'idle',
  requesting: false,
  requestError: null,
  requestOutcome: null,
  notifications: null,
  notificationsStatus: 'idle',
  notificationsSaving: false,
  notificationsError: null,
};

function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

/**
 * Builder Settings state (#871): profile & branding, embed install data,
 * origin-change requests, and email notification preferences (#864). Memory-only (never persisted) and lazy-
 * provided at the `/builder/settings` route.
 *
 * Action handlers RETURN their API observables: NGXS owns the
 * subscription. Failures land in state (never thrown) so the page can
 * show them inline; the component reads `saveError` / `requestError`
 * after the dispatch completes to decide on the success toast.
 */
@State<BuilderSettingsStateModel>({
  name: 'builderSettings',
  defaults,
})
@Injectable()
export class BuilderSettingsState {
  private readonly api = inject(BuilderSettingsApiService);

  @Selector()
  static profile(state: BuilderSettingsStateModel): BuilderProfile | null {
    return state.profile;
  }

  @Selector()
  static canEdit(state: BuilderSettingsStateModel): boolean {
    return state.canEdit;
  }

  @Selector()
  static support(state: BuilderSettingsStateModel): BuilderSupportContact | null {
    return state.support;
  }

  @Selector()
  static profileStatus(state: BuilderSettingsStateModel): BuilderSettingsLoadStatus {
    return state.profileStatus;
  }

  @Selector()
  static saving(state: BuilderSettingsStateModel): boolean {
    return state.saving;
  }

  @Selector()
  static saveError(state: BuilderSettingsStateModel): string | null {
    return state.saveError;
  }

  @Selector()
  static embed(state: BuilderSettingsStateModel): BuilderEmbedResponse | null {
    return state.embed;
  }

  @Selector()
  static embedStatus(state: BuilderSettingsStateModel): BuilderSettingsLoadStatus {
    return state.embedStatus;
  }

  @Selector()
  static requesting(state: BuilderSettingsStateModel): boolean {
    return state.requesting;
  }

  @Selector()
  static requestError(state: BuilderSettingsStateModel): string | null {
    return state.requestError;
  }

  @Selector()
  static requestOutcome(state: BuilderSettingsStateModel): BuilderOriginRequestOutcome {
    return state.requestOutcome;
  }

  @Selector()
  static notifications(
    state: BuilderSettingsStateModel,
  ): BuilderNotificationPreferencesResponse | null {
    return state.notifications;
  }

  @Selector()
  static notificationsStatus(state: BuilderSettingsStateModel): BuilderSettingsLoadStatus {
    return state.notificationsStatus;
  }

  @Selector()
  static notificationsSaving(state: BuilderSettingsStateModel): boolean {
    return state.notificationsSaving;
  }

  @Selector()
  static notificationsError(state: BuilderSettingsStateModel): string | null {
    return state.notificationsError;
  }

  @Action(LoadBuilderProfile)
  loadProfile(ctx: StateContext<BuilderSettingsStateModel>): Observable<unknown> {
    ctx.patchState({ profileStatus: 'loading' });
    return this.api.getProfile().pipe(
      tap((res) => {
        ctx.patchState({
          profile: res.profile,
          canEdit: res.canEdit,
          support: res.support,
          profileStatus: 'ready',
        });
      }),
      catchError(() => {
        ctx.patchState({ profileStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(SaveBuilderProfile)
  saveProfile(
    ctx: StateContext<BuilderSettingsStateModel>,
    action: SaveBuilderProfile,
  ): Observable<unknown> {
    if (ctx.getState().saving) return of(null);
    ctx.patchState({ saving: true, saveError: null });
    return this.api.updateProfile(action.body).pipe(
      tap((res) => {
        ctx.patchState({
          profile: res.profile,
          canEdit: res.canEdit,
          support: res.support,
          saving: false,
        });
      }),
      catchError((err: unknown) => {
        ctx.patchState({ saving: false, saveError: errorMessage(err) });
        return of(null);
      }),
    );
  }

  @Action(LoadBuilderEmbed)
  loadEmbed(ctx: StateContext<BuilderSettingsStateModel>): Observable<unknown> {
    ctx.patchState({ embedStatus: 'loading' });
    return this.api.getEmbed().pipe(
      tap((embed) => {
        ctx.patchState({ embed, embedStatus: 'ready' });
      }),
      catchError(() => {
        ctx.patchState({ embedStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(RequestBuilderOriginChange)
  requestOriginChange(
    ctx: StateContext<BuilderSettingsStateModel>,
    action: RequestBuilderOriginChange,
  ): Observable<unknown> {
    if (ctx.getState().requesting) return of(null);
    ctx.patchState({ requesting: true, requestError: null, requestOutcome: null });
    return this.api.requestOriginChange(action.body).pipe(
      tap((res) => {
        const embed = ctx.getState().embed;
        const others = (embed?.openRequests ?? []).filter((r) => r.id !== res.request.id);
        ctx.patchState({
          requesting: false,
          requestOutcome: res.created ? 'created' : 'duplicate',
          embed: embed ? { ...embed, openRequests: [res.request, ...others] } : embed,
        });
      }),
      catchError((err: unknown) => {
        ctx.patchState({ requesting: false, requestError: errorMessage(err) });
        return of(null);
      }),
    );
  }

  @Action(LoadBuilderNotificationPreferences)
  loadNotifications(ctx: StateContext<BuilderSettingsStateModel>): Observable<unknown> {
    ctx.patchState({ notificationsStatus: 'loading' });
    return this.api.getNotificationPreferences().pipe(
      tap((notifications) => {
        ctx.patchState({ notifications, notificationsStatus: 'ready' });
      }),
      catchError(() => {
        ctx.patchState({ notificationsStatus: 'error' });
        return of(null);
      }),
    );
  }

  /**
   * Server state wins: on success the response replaces the toggles; on
   * failure (409 LAST_ADMIN, 403 view-as, network) the toggles keep the
   * last server state and the API's message lands in `notificationsError`.
   */
  @Action(SaveBuilderNotificationPreferences)
  saveNotifications(
    ctx: StateContext<BuilderSettingsStateModel>,
    action: SaveBuilderNotificationPreferences,
  ): Observable<unknown> {
    if (ctx.getState().notificationsSaving) return of(null);
    ctx.patchState({ notificationsSaving: true, notificationsError: null });
    return this.api.updateNotificationPreferences(action.body).pipe(
      tap((notifications) => {
        ctx.patchState({ notifications, notificationsSaving: false });
      }),
      catchError((err: unknown) => {
        ctx.patchState({ notificationsSaving: false, notificationsError: errorMessage(err) });
        return of(null);
      }),
    );
  }

  @Action(ClearBuilderSettingsErrors)
  clearErrors(ctx: StateContext<BuilderSettingsStateModel>): void {
    ctx.patchState({
      saveError: null,
      requestError: null,
      requestOutcome: null,
      notificationsError: null,
    });
  }
}

/**
 * Lazy provider for the `builder/settings` route (lazyProvider in
 * app.routes.ts): keeps the state out of the initial bundle. BUILDER_COPY
 * is registered in the same environment injector (see
 * builderInvoicesStateProvider for why).
 */
export const builderSettingsStateProvider: EnvironmentProviders =
  makeEnvironmentProviders([provideBuilderCopy(), provideStates([BuilderSettingsState])]);
