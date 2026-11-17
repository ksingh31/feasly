import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { of, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityMatchRequest, CommunityMatchResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { mockCommunityMatch } from '../../core/api/mock-data';
import { ConfigService } from '../../core/config';
import {
  ClearMatchCompare,
  CycleMatchPriority,
  LoadCommunityMatches,
  SetMatchSelection,
  ToggleMatchCompare,
  ToggleMatchFilter,
} from './find-community.actions';
import { FindCommunitySelectionState, FindCommunityState } from './find-community.state';

describe('FindCommunityState (#779)', () => {
  let store: Store;
  let api: { matchCommunities: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      matchCommunities: vi.fn((req: CommunityMatchRequest) => of(mockCommunityMatch(req))),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([FindCommunitySelectionState, FindCommunityState]),
        { provide: API_SERVICE, useValue: api },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    store = TestBed.inject(Store);
  });

  it('stays idle and calls nothing without a priority', () => {
    store.dispatch(new LoadCommunityMatches());
    expect(api.matchCommunities).not.toHaveBeenCalled();
    expect(store.selectSnapshot(FindCommunityState.status)).toBe('idle');
  });

  it('sends one request built from the selection and stores the ranking', () => {
    store.dispatch(new CycleMatchPriority('parks'));
    store.dispatch(new CycleMatchPriority('parks'));
    store.dispatch(new ToggleMatchFilter('wide-lot'));
    store.dispatch(new LoadCommunityMatches());
    expect(api.matchCommunities).toHaveBeenCalledTimes(1);
    expect(api.matchCommunities).toHaveBeenCalledWith({
      priorities: [{ key: 'parks', importance: 'must' }],
      filters: { minFrontageFt: 50 },
      limit: 30,
    });
    expect(store.selectSnapshot(FindCommunityState.status)).toBe('ready');
    expect(store.selectSnapshot(FindCommunityState.response)?.results.length).toBeGreaterThan(0);
  });

  it('a newer load cancels a slower in-flight one', () => {
    const first = new Subject<CommunityMatchResponse>();
    api.matchCommunities.mockReturnValueOnce(first);
    store.dispatch(new SetMatchSelection({ priorities: [{ key: 'parks', importance: 'nice' }], filters: [] }));
    store.dispatch(new LoadCommunityMatches());
    store.dispatch(new SetMatchSelection({ priorities: [{ key: 'pools', importance: 'nice' }], filters: [] }));
    store.dispatch(new LoadCommunityMatches());
    const latest = store.selectSnapshot(FindCommunityState.response);
    first.next(mockCommunityMatch({ priorities: [{ key: 'parks', importance: 'nice' }] }));
    expect(store.selectSnapshot(FindCommunityState.response)).toBe(latest);
  });

  it('shows the error state when the request fails', () => {
    api.matchCommunities.mockReturnValueOnce(throwError(() => ({ code: 'http_500' })));
    store.dispatch(new CycleMatchPriority('parks'));
    store.dispatch(new LoadCommunityMatches());
    expect(store.selectSnapshot(FindCommunityState.status)).toBe('error');
  });

  it('blocks a 4th compare pick with a flag, and unblocks on the next change', () => {
    store.dispatch(new CycleMatchPriority('parks'));
    store.dispatch(new LoadCommunityMatches());
    const codes = store.selectSnapshot(FindCommunityState.response)!.results.map((r) => r.communityCode);
    for (const code of codes.slice(0, 4)) store.dispatch(new ToggleMatchCompare(code));
    expect(store.selectSnapshot(FindCommunityState.compare).map((c) => c.communityCode)).toEqual(codes.slice(0, 3));
    expect(store.selectSnapshot(FindCommunityState.compareBlocked)).toBe(true);

    store.dispatch(new ToggleMatchCompare(codes[0]!));
    expect(store.selectSnapshot(FindCommunityState.compareBlocked)).toBe(false);
    expect(store.selectSnapshot(FindCommunityState.compare)).toHaveLength(2);

    store.dispatch(new ClearMatchCompare());
    expect(store.selectSnapshot(FindCommunityState.compare)).toEqual([]);
  });

  it('keeps compare picks across a re-rank', () => {
    store.dispatch(new CycleMatchPriority('parks'));
    store.dispatch(new LoadCommunityMatches());
    store.dispatch(new ToggleMatchCompare('ALT'));
    store.dispatch(new SetMatchSelection({ priorities: [{ key: 'pools', importance: 'must' }], filters: [] }));
    store.dispatch(new LoadCommunityMatches());
    expect(store.selectSnapshot(FindCommunityState.compare).map((c) => c.communityCode)).toEqual(['ALT']);
  });
});
