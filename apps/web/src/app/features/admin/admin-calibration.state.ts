import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { inject } from '@angular/core';
import { tap, catchError, EMPTY } from 'rxjs';
import type { AdminCalibrationResponse } from '@feasly/contracts';
import { AdminCalibrationApiService } from './admin-calibration-api.service';

/** Load lifecycle for the calibration console. */
export type CalibrationStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CalibrationStateModel {
  /** The calibration payload from the backend. Null until loaded. */
  calibration: AdminCalibrationResponse | null;
  status: CalibrationStatus;
  /** Load failure flag. The raw error never reaches the UI. */
  error: string | null;
}

const defaults: CalibrationStateModel = {
  calibration: null,
  status: 'idle',
  error: null,
};

/** Trigger a (re)load of the calibration console payload. */
export class LoadCalibration {
  static readonly type = '[Calibration] Load';
}

/**
 * Calibration console state (admin/09): the single source of truth for the
 * `/admin/calibration` page.
 *
 * Memory-only — deliberately NOT registered with the storage plugin.
 * Calibration data is admin-internal and must never persist in the
 * browser's localStorage.
 *
 * The component never calls the API directly — it dispatches
 * `LoadCalibration` and renders selectors.
 */
@State<CalibrationStateModel>({
  name: 'calibration',
  defaults,
})
@Injectable()
export class CalibrationState {
  private readonly api = inject(AdminCalibrationApiService);

  @Selector()
  static calibration(
    state: CalibrationStateModel,
  ): AdminCalibrationResponse | null {
    return state.calibration;
  }

  @Selector()
  static status(state: CalibrationStateModel): CalibrationStatus {
    return state.status;
  }

  @Selector()
  static error(state: CalibrationStateModel): string | null {
    return state.error;
  }

  @Action(LoadCalibration)
  load(ctx: StateContext<CalibrationStateModel>) {
    ctx.patchState({ status: 'loading', error: null });
    return this.api.getCalibration().pipe(
      tap((calibration) => {
        ctx.patchState({ calibration, status: 'ready', error: null });
      }),
      catchError(() => {
        ctx.patchState({
          status: 'error',
          error: 'Could not load the calibration console. Try again.',
        });
        return EMPTY;
      }),
    );
  }
}
