import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { Subject, throwError } from 'rxjs';
import type { BuilderPartnerListResponse } from '@feasly/contracts';
import { API_SERVICE } from '../api/api.service';
import { LoadPartners } from './partners.actions';
import { PartnersState } from './partners.state';

const LIST: BuilderPartnerListResponse = {
  partners: [
    { id: 'p1', name: 'Elite Craft Builders', logoUrl: null, websiteUrl: 'https://elite.example', description: null },
  ],
};

/**
 * #918: the partner list is read once per session through one NGXS state
 * and shared by every disclosure location.
 */
describe('PartnersState', () => {
  function setup(getPartners: () => unknown, platform = 'browser'): Store {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideStore([PartnersState]),
        { provide: API_SERVICE, useValue: { getPartners } },
        { provide: PLATFORM_ID, useValue: platform },
      ],
    });
    return TestBed.inject(Store);
  }

  it('makes ONE partners request per session, however many surfaces ask', () => {
    const response = new Subject<BuilderPartnerListResponse>();
    const getPartners = vi.fn(() => response);
    const store = setup(getPartners);

    // Gate, report and How it works all dispatch — while in flight…
    store.dispatch(new LoadPartners());
    store.dispatch(new LoadPartners());
    expect(store.selectSnapshot(PartnersState.status)).toBe('loading');
    response.next(LIST);
    response.complete();
    // …and after the list has loaded.
    store.dispatch(new LoadPartners());
    store.dispatch(new LoadPartners());

    expect(getPartners).toHaveBeenCalledTimes(1);
    expect(store.selectSnapshot(PartnersState.status)).toBe('ready');
    expect(store.selectSnapshot(PartnersState.partners)).toEqual(LIST.partners);
  });

  it('does not cache a failure: the next surface retries', () => {
    const getPartners = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValueOnce(new Subject<BuilderPartnerListResponse>());
    const store = setup(getPartners);

    store.dispatch(new LoadPartners());
    expect(store.selectSnapshot(PartnersState.status)).toBe('error');
    expect(store.selectSnapshot(PartnersState.partners)).toEqual([]);

    store.dispatch(new LoadPartners());
    expect(getPartners).toHaveBeenCalledTimes(2);
  });

  it('never fetches during prerender/SSR', () => {
    const getPartners = vi.fn();
    const store = setup(getPartners, 'server');
    store.dispatch(new LoadPartners());
    expect(getPartners).not.toHaveBeenCalled();
    expect(store.selectSnapshot(PartnersState.status)).toBe('idle');
  });
});
