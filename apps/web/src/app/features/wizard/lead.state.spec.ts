import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClearLead, StoreLeadResult } from './lead.actions';
import { LeadState, type LeadStateModel } from './lead.state';

/** FE-004: lead receipt state stays in memory and clears on demand. */
describe('LeadState', () => {
  let store: Store;

  function snapshot(): LeadStateModel {
    return store.selectSnapshot<LeadStateModel>((state) => state.lead);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideStore([LeadState])] });
    store = TestBed.inject(Store);
  });

  it('starts empty', () => {
    const state = snapshot();
    expect(state.leadId).toBeNull();
    expect(state.email).toBeNull();
    expect(state.magicLinkSent).toBe(false);
    expect(state.expiresInDays).toBeNull();
  });

  it('StoreLeadResult keeps the receipt; selectors expose it', () => {
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-mock-1',
        email: 'jane@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    expect(store.selectSnapshot(LeadState.leadId)).toBe('lead-mock-1');
    expect(store.selectSnapshot(LeadState.email)).toBe('jane@example.com');
    expect(snapshot().expiresInDays).toBe(7);
  });

  it('ClearLead drops the receipt', () => {
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-mock-1',
        email: 'jane@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new ClearLead());
    expect(snapshot().leadId).toBeNull();
    expect(snapshot().email).toBeNull();
  });
});
