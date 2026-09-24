import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { ClearLead, StoreLeadResult } from './lead.actions';

export interface LeadStateModel {
  /** Backend lead id from submitLead. Null until the gate POST succeeds. */
  leadId: string | null;
  /** Email the magic link was sent to (display only). */
  email: string | null;
  magicLinkSent: boolean;
  /** Rendered in the UI from this value — never hardcoded. */
  expiresInDays: number | null;
}

/**
 * Lead state (FE-004): the receipt for the single lead-gate POST.
 *
 * Persisted (storage plugin): leadId, email, magicLinkSent, expiresInDays —
 * the receipt the report page needs to render the pending "check your email"
 * state after a reload, instead of looping the user back to an empty gate.
 * The lead's NAME never enters this store (it stays in the gate form), and
 * there is no Bearer <redacted> here — the report token lives in ReportState
 * memory only.
 */
@State<LeadStateModel>({
  name: 'lead',
  defaults: {
    leadId: null,
    email: null,
    magicLinkSent: false,
    expiresInDays: null,
  },
})
@Injectable()
export class LeadState {
  @Selector()
  static leadId(state: LeadStateModel): string | null {
    return state.leadId;
  }

  @Selector()
  static email(state: LeadStateModel): string | null {
    return state.email;
  }

  @Action(StoreLeadResult)
  storeLeadResult(ctx: StateContext<LeadStateModel>, action: StoreLeadResult): void {
    ctx.patchState({ ...action.result });
  }

  @Action(ClearLead)
  clearLead(ctx: StateContext<LeadStateModel>): void {
    ctx.setState({ leadId: null, email: null, magicLinkSent: false, expiresInDays: null });
  }
}
