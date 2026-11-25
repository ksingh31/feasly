import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { of, Subject } from 'rxjs';
import type { CommunityLivingResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import {
  mockCommunityLiving,
  mockCommunitySchoolDesignations,
  mockCommunitySchools,
} from '../../core/api/mock-community-guide';
import {
  LoadCommunityLiving,
  LoadCommunitySchools,
  OpenCommunityGuide,
  SelectCommunityGuideTab,
  SetSchoolTypeFilter,
} from './community-guide.actions';
import { CommunityGuideState } from './community-guide.state';

describe('CommunityGuideState (#781)', () => {
  function setup(api: Record<string, unknown>, platform = 'browser'): Store {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideStore([CommunityGuideState]),
        { provide: API_SERVICE, useValue: api },
        { provide: PLATFORM_ID, useValue: platform },
      ],
    });
    return TestBed.inject(Store);
  }

  const okApi = () => ({
    getCommunitySchoolDesignations: vi.fn((s: string) => of(mockCommunitySchoolDesignations(s))),
    listCommunitySchools: vi.fn((c: string) => of(mockCommunitySchools(c))),
    getCommunityLiving: vi.fn((s: string) => of(mockCommunityLiving(s))),
  });

  it('never fetches during prerender/SSR', () => {
    const api = okApi();
    const store = setup(api, 'server');
    store.dispatch([new OpenCommunityGuide('a'), new LoadCommunitySchools(), new LoadCommunityLiving()]);
    expect(api.getCommunitySchoolDesignations).not.toHaveBeenCalled();
    expect(api.getCommunityLiving).not.toHaveBeenCalled();
  });

  it('opening a new slug resets tab, filter and data; reopening the same slug keeps them', () => {
    const store = setup(okApi());
    store.dispatch([
      new OpenCommunityGuide('a'),
      new SelectCommunityGuideTab('schools'),
      new SetSchoolTypeFilter('private'),
      new LoadCommunityLiving(),
    ]);
    store.dispatch(new OpenCommunityGuide('a'));
    expect(store.selectSnapshot(CommunityGuideState.tab)).toBe('schools');
    store.dispatch(new OpenCommunityGuide('b'));
    expect(store.selectSnapshot(CommunityGuideState.tab)).toBe('overview');
    expect(store.selectSnapshot(CommunityGuideState.schoolTypeFilter)).toBe('all');
    expect(store.selectSnapshot(CommunityGuideState.living)).toBeNull();
    expect(store.selectSnapshot(CommunityGuideState.livingStatus)).toBe('idle');
  });

  it('drops a late answer for a community the visitor already left', () => {
    const living$ = new Subject<CommunityLivingResponse>();
    const store = setup({ getCommunityLiving: vi.fn(() => living$) });
    store.dispatch([new OpenCommunityGuide('a'), new LoadCommunityLiving()]);
    store.dispatch(new OpenCommunityGuide('b'));
    living$.next(mockCommunityLiving('a'));
    living$.complete();
    expect(store.selectSnapshot(CommunityGuideState.living)).toBeNull();
  });
});
