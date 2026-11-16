import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { ApiError } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { ClearReport } from '../report/report.actions';
import { ClearLead } from '../wizard/lead.actions';
import { ClearComparison, ResetWizard } from '../wizard/wizard.actions';
import {
  CancelErasure,
  ConfirmErasure,
  DownloadMyData,
  RequestErasure,
  ResendErasureEmail,
  ResetPrivacy,
  SendPrivacyLink,
} from './privacy.actions';
import { PrivacyFileService } from './privacy-file.service';

/** Failure states shared by every privacy action. */
export type PrivacyFailure = 'expired' | 'rate-limited' | 'error';
export type DownloadStatus = 'idle' | 'working' | 'done' | PrivacyFailure;
export type EraseStatus = 'idle' | 'working' | 'pending' | PrivacyFailure;
export type ConfirmStatus =
  | 'idle'
  | 'working'
  | 'done'
  | 'already-done'
  | 'blocked'
  | 'invalid'
  | PrivacyFailure;
/**
 * #806: did the API email the confirmation link for the pending request?
 * `not-sent` covers a duplicate inside the resend cooldown, a spent send
 * budget, or a failed delivery — the API doesn't say which.
 */
export type EraseEmailStatus = 'unknown' | 'sent' | 'not-sent' | 'resending';
export type LinkStatus = 'idle' | 'working' | 'sent' | 'rate-limited' | 'error';

/**
 * Privacy self-service state (#706). Status per action only: the export
 * payload goes straight to a file and is never stored; the token is never
 * stored here. Memory-only — deliberately not in the storage-plugin keys.
 */
export interface PrivacyStateModel {
  download: DownloadStatus;
  erase: EraseStatus;
  eraseRequestId: string | null;
  /** Draft consequences statements from the API (shown before confirming). */
  consequences: readonly string[];
  eraseEmail: EraseEmailStatus;
  confirm: ConfirmStatus;
  link: LinkStatus;
}

const defaults: PrivacyStateModel = {
  download: 'idle',
  erase: 'idle',
  eraseRequestId: null,
  consequences: [],
  eraseEmail: 'unknown',
  confirm: 'idle',
  link: 'idle',
};

function codeOf(err: unknown): string {
  return typeof (err as ApiError | undefined)?.code === 'string' ? (err as ApiError).code : '';
}

/** Maps an API failure to the shared failure states. Bearer denials (401 UNAUTHENTICATED, or 403) = expired link. */
export function toPrivacyFailure(err: unknown): PrivacyFailure {
  const code = codeOf(err);
  if (code === 'RATE_LIMITED' || code === 'http_429') return 'rate-limited';
  if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED' || code === 'http_401' || code === 'http_403') {
    return 'expired';
  }
  return 'error';
}

/**
 * Confirm-specific mapping: 409 = completed (or blocked), 404 = unknown request id.
 * 403 here means the request id belongs to another identity (token failures are
 * 401), so it reads as an invalid link rather than an expired one.
 */
export function toConfirmStatus(err: unknown): ConfirmStatus {
  const code = codeOf(err);
  if (code === 'FORBIDDEN' || code === 'http_403') return 'invalid';
  if (code === 'CONFLICT' || code === 'http_409') {
    // The backend answers 409 for both outcomes; only a blocked erasure says so.
    const message = (err as ApiError | undefined)?.message ?? '';
    return /blocked/i.test(message) ? 'blocked' : 'already-done';
  }
  if (code === 'NOT_FOUND' || code === 'http_404') return 'invalid';
  return toPrivacyFailure(err);
}

@State<PrivacyStateModel>({ name: 'privacy', defaults })
@Injectable()
export class PrivacyState {
  private readonly api = inject(API_SERVICE);
  private readonly config = inject(ConfigService);
  private readonly files = inject(PrivacyFileService);

  @Selector()
  static download(state: PrivacyStateModel): DownloadStatus {
    return state.download;
  }

  @Selector()
  static erase(state: PrivacyStateModel): EraseStatus {
    return state.erase;
  }

  @Selector()
  static eraseRequestId(state: PrivacyStateModel): string | null {
    return state.eraseRequestId;
  }

  @Selector()
  static consequences(state: PrivacyStateModel): readonly string[] {
    return state.consequences;
  }

  @Selector()
  static eraseEmail(state: PrivacyStateModel): EraseEmailStatus {
    return state.eraseEmail;
  }

  @Selector()
  static confirm(state: PrivacyStateModel): ConfirmStatus {
    return state.confirm;
  }

  @Selector()
  static link(state: PrivacyStateModel): LinkStatus {
    return state.link;
  }

  @Action(ResetPrivacy)
  reset(ctx: StateContext<PrivacyStateModel>): void {
    ctx.setState({ ...defaults });
  }

  @Action(DownloadMyData)
  downloadMyData(ctx: StateContext<PrivacyStateModel>, action: DownloadMyData): Observable<void> {
    ctx.patchState({ download: 'working' });
    return this.api.exportPrivacyData(action.reportToken).pipe(
      tap((payload) => {
        this.files.saveJson(this.config.get('copy').privacyData.downloadFileName, payload);
        ctx.patchState({ download: 'done' });
      }),
      map(() => undefined),
      catchError((err: unknown) => {
        ctx.patchState({ download: toPrivacyFailure(err) });
        return of(undefined);
      }),
    );
  }

  @Action(RequestErasure)
  requestErasure(ctx: StateContext<PrivacyStateModel>, action: RequestErasure): Observable<void> {
    ctx.patchState({ erase: 'working' });
    return this.api.requestErasure(action.reportToken).pipe(
      tap((res) =>
        ctx.patchState({
          erase: 'pending',
          eraseRequestId: res.requestId,
          consequences: res.consequences,
          eraseEmail: res.confirmationEmailSent ? 'sent' : 'not-sent',
        }),
      ),
      map(() => undefined),
      catchError((err: unknown) => {
        ctx.patchState({ erase: toPrivacyFailure(err) });
        return of(undefined);
      }),
    );
  }

  @Action(ResendErasureEmail)
  resendErasureEmail(ctx: StateContext<PrivacyStateModel>, action: ResendErasureEmail): Observable<void> {
    // Stays on the pending panel; only the email status changes.
    ctx.patchState({ eraseEmail: 'resending' });
    return this.api.requestErasure(action.reportToken).pipe(
      tap((res) =>
        ctx.patchState({
          eraseRequestId: res.requestId,
          consequences: res.consequences,
          eraseEmail: res.confirmationEmailSent ? 'sent' : 'not-sent',
        }),
      ),
      map(() => undefined),
      catchError((err: unknown) => {
        const failure = toPrivacyFailure(err);
        ctx.patchState(
          failure === 'expired'
            ? { erase: 'expired', eraseEmail: 'unknown' }
            : { erase: failure, eraseEmail: 'not-sent' },
        );
        return of(undefined);
      }),
    );
  }

  @Action(CancelErasure)
  cancelErasure(ctx: StateContext<PrivacyStateModel>): void {
    ctx.patchState({ erase: 'idle', eraseRequestId: null, consequences: [], eraseEmail: 'unknown' });
  }

  @Action(ConfirmErasure)
  confirmErasure(ctx: StateContext<PrivacyStateModel>, action: ConfirmErasure): Observable<void> {
    ctx.patchState({ confirm: 'working' });
    return this.api.confirmErasure(action.reportToken, action.requestId).pipe(
      tap(() => {
        ctx.patchState({
          confirm: 'done',
          erase: 'idle',
          eraseRequestId: null,
          consequences: [],
          eraseEmail: 'unknown',
        });
        // Erased server-side: drop every local copy (wizard, lead, report + its token).
        ctx.dispatch([new ClearReport(), new ClearLead(), new ResetWizard(), new ClearComparison()]);
      }),
      map(() => undefined),
      catchError((err: unknown) => {
        ctx.patchState({ confirm: toConfirmStatus(err) });
        return of(undefined);
      }),
    );
  }

  @Action(SendPrivacyLink)
  sendLink(ctx: StateContext<PrivacyStateModel>, action: SendPrivacyLink): Observable<void> {
    ctx.patchState({ link: 'working' });
    return this.api.reissueMagicLink({ email: action.email }).pipe(
      // `sent` is deliberately ignored: known and unknown emails get the
      // same on-screen answer (no enumeration oracle).
      tap(() => ctx.patchState({ link: 'sent' })),
      map(() => undefined),
      catchError((err: unknown) => {
        ctx.patchState({ link: toPrivacyFailure(err) === 'rate-limited' ? 'rate-limited' : 'error' });
        return of(undefined);
      }),
    );
  }
}

/** Route-level registration (lazy chunk). */
export const privacyStateProvider = provideStates([PrivacyState]);
