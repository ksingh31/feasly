import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { AcknowledgeConsent, ResetConsent } from './consent.actions';

export type ConsentStatus = 'pending' | 'granted' | 'declined';

export interface ConsentStateModel {
  /** 'pending' until the visitor answers the banner. */
  status: ConsentStatus;
  /**
   * ISO timestamp of the last banner acknowledgement. Every analytics
   * event carries this as `consent_ts`; re-acknowledging updates it
   * (acceptance criterion 5).
   */
  consentTs: string | null;
}

/** The storage-plugin key for this state (mirrors the @State name). */
export const ConsentStateName = 'consent';

/**
 * First-party analytics consent (story consumer/01). Persisted to
 * localStorage via the NGXS storage plugin so the choice survives refresh —
 * the banner only ever renders for 'pending'.
 */
@State<ConsentStateModel>({
  name: ConsentStateName,
  defaults: {
    status: 'pending',
    consentTs: null,
  },
})
@Injectable()
export class ConsentState {
  @Selector()
  static status(state: ConsentStateModel): ConsentStatus {
    return state.status;
  }

  @Selector()
  static consentTs(state: ConsentStateModel): string | null {
    return state.consentTs;
  }

  /** True when the banner must render (no choice recorded yet). */
  @Selector()
  static bannerVisible(state: ConsentStateModel): boolean {
    return state.status === 'pending';
  }

  @Action(AcknowledgeConsent)
  acknowledge(
    ctx: StateContext<ConsentStateModel>,
    action: AcknowledgeConsent,
  ): void {
    ctx.patchState({
      status: action.granted ? 'granted' : 'declined',
      // Re-acknowledging always refreshes the timestamp.
      consentTs: new Date().toISOString(),
    });
  }

  @Action(ResetConsent)
  reset(ctx: StateContext<ConsentStateModel>): void {
    ctx.patchState({ status: 'pending', consentTs: null });
  }
}
