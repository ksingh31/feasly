import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { API_SERVICE } from '../../core/api/api.service';
import { mockAddressSchoolDesignations, mockCommunityLiving } from '../../core/api/mock-data';
import { LoadReportNeighbourhood } from './report-neighbourhood.actions';
import { ReportNeighbourhoodState } from './report-neighbourhood.state';

function setup(living: () => unknown = () => of(mockCommunityLiving('capitol-hill'))) {
  const api = {
    getAddressSchoolDesignations: vi.fn((key: string) => of(mockAddressSchoolDesignations(key))),
    getCommunityLiving: vi.fn(living),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideStore([ReportNeighbourhoodState]), { provide: API_SERVICE, useValue: api }],
  });
  return { api, store: TestBed.inject(Store) };
}

describe('ReportNeighbourhoodState (#785)', () => {
  it('loads designations, then the community living metrics', () => {
    const { store } = setup();
    store.dispatch(new LoadReportNeighbourhood('a-1'));
    expect(store.selectSnapshot(ReportNeighbourhoodState.status)).toBe('ready');
    expect(store.selectSnapshot(ReportNeighbourhoodState.schools)?.addressKey).toBe('a-1');
    expect(store.selectSnapshot(ReportNeighbourhoodState.living)?.slug).toBe('capitol-hill');
  });

  it('makes one request per address (a repeat is a no-op)', () => {
    const { store, api } = setup();
    store.dispatch(new LoadReportNeighbourhood('a-1'));
    store.dispatch(new LoadReportNeighbourhood('a-1'));
    expect(api.getAddressSchoolDesignations).toHaveBeenCalledTimes(1);
    expect(api.getCommunityLiving).toHaveBeenCalledTimes(1);
    store.dispatch(new LoadReportNeighbourhood('a-2'));
    expect(api.getAddressSchoolDesignations).toHaveBeenCalledTimes(2);
    expect(store.selectSnapshot(ReportNeighbourhoodState.schools)?.addressKey).toBe('a-2');
  });

  it('a failed living read keeps the schools and ends ready', () => {
    const { store } = setup(() => throwError(() => new Error('down')));
    store.dispatch(new LoadReportNeighbourhood('a-1'));
    expect(store.selectSnapshot(ReportNeighbourhoodState.status)).toBe('ready');
    expect(store.selectSnapshot(ReportNeighbourhoodState.schools)).not.toBeNull();
    expect(store.selectSnapshot(ReportNeighbourhoodState.living)).toBeNull();
  });
});
