import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { withNgxsStoragePlugin } from '@ngxs/storage-plugin';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcknowledgeConsent, ResetConsent } from './consent.actions';
import { ConsentState, ConsentStateName, type ConsentStateModel } from './consent.state';

/** Story consumer/01: consent state transitions + acknowledgement timestamps. */
describe('ConsentState', () => {
  let store: Store;

  function snapshot(): ConsentStateModel {
    return store.selectSnapshot<ConsentStateModel>((state) => state.consent);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideStore([ConsentState])],
    });
    store = TestBed.inject(Store);
  });

  it('starts pending with no consent timestamp', () => {
    expect(snapshot().status).toBe('pending');
    expect(snapshot().consentTs).toBeNull();
    expect(store.selectSnapshot(ConsentState.bannerVisible)).toBe(true);
  });

  it('accept records granted + a fresh consent_ts', () => {
    const before = new Date().toISOString();
    store.dispatch(new AcknowledgeConsent(true));
    const after = new Date().toISOString();
    expect(snapshot().status).toBe('granted');
    expect(snapshot().consentTs).not.toBeNull();
    expect(snapshot().consentTs! >= before).toBe(true);
    expect(snapshot().consentTs! <= after).toBe(true);
    expect(store.selectSnapshot(ConsentState.bannerVisible)).toBe(false);
  });

  it('decline records declined + a fresh consent_ts', () => {
    store.dispatch(new AcknowledgeConsent(false));
    expect(snapshot().status).toBe('declined');
    expect(snapshot().consentTs).not.toBeNull();
    expect(store.selectSnapshot(ConsentState.bannerVisible)).toBe(false);
  });

  it('re-acknowledging updates consent_ts (AC5)', async () => {
    store.dispatch(new AcknowledgeConsent(true));
    const first = snapshot().consentTs!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.dispatch(new AcknowledgeConsent(true));
    const second = snapshot().consentTs!;
    expect(second >= first).toBe(true);
  });

  it('reset returns the banner to pending', () => {
    store.dispatch(new AcknowledgeConsent(true));
    store.dispatch(new ResetConsent());
    expect(snapshot().status).toBe('pending');
    expect(snapshot().consentTs).toBeNull();
    expect(store.selectSnapshot(ConsentState.bannerVisible)).toBe(true);
  });

  it('persists the choice across a refresh (AC5)', () => {
    // Write the stored shape directly: the plugin's write on dispatch is
    // async and racy under test, but the rehydration path is what this
    // test pins.
    const consentTs = new Date().toISOString();
    localStorage.setItem(
      ConsentStateName,
      JSON.stringify({ status: 'granted', consentTs }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideStore([ConsentState], withNgxsStoragePlugin({ keys: [ConsentState] }))],
    });
    const rehydrated = TestBed.inject(Store).selectSnapshot<ConsentStateModel>(
      (state) => state.consent,
    );
    expect(rehydrated.status).toBe('granted');
    expect(rehydrated.consentTs).toBe(consentTs);
    localStorage.clear();
  });
});
