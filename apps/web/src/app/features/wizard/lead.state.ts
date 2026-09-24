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
 * Deliberately NOT registered with the storage plugin: name/email are PII and
 * stay in memory only. The blurred preview (no PII) lives in WizardState and
 * is the persisted piece the report page needs.
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
