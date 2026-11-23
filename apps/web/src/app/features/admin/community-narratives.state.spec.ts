import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminCommunityNarrativeEntry,
  AdminCommunityNarrativeRegenerateResponse,
} from '@feasly/contracts';
import { AdminOpsApiService } from './admin-ops-api.service';
import {
  LoadCommunityNarratives,
  RegenerateCommunityNarratives,
} from './community-narratives.actions';
import { CommunityNarrativesState } from './community-narratives.state';

const ROW: AdminCommunityNarrativeEntry = {
  community_slug: 'altadore',
  community_name: 'Altadore',
  period: '2026-11',
  status: 'succeeded',
  generated_at: '2026-11-02T09:00:00.000Z',
  attempts: 1,
  last_error: null,
};

const RESULT: AdminCommunityNarrativeRegenerateResponse = {
  scope: 'one',
  period: '2026-11',
  attempted: 1,
  succeeded: 1,
  failed: 0,
  deferred: 0,
};

describe('CommunityNarrativesState (#915)', () => {
  let store: Store;
  let api: {
    getCommunityNarratives: ReturnType<typeof vi.fn>;
    regenerateCommunityNarratives: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    api = {
      getCommunityNarratives: vi.fn().mockReturnValue(of({ communities: [ROW] })),
      regenerateCommunityNarratives: vi.fn().mockReturnValue(of(RESULT)),
    };
    TestBed.configureTestingModule({
      providers: [provideStore([CommunityNarrativesState]), { provide: AdminOpsApiService, useValue: api }],
    });
    store = TestBed.inject(Store);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('loads the communities', () => {
    store.dispatch(new LoadCommunityNarratives());
    expect(store.selectSnapshot(CommunityNarrativesState.communities)).toEqual([ROW]);
    expect(store.selectSnapshot(CommunityNarrativesState.loadStatus)).toBe('ready');
  });

  it('surfaces a friendly error when the load fails', () => {
    api.getCommunityNarratives.mockReturnValue(throwError(() => new Error('boom')));
    store.dispatch(new LoadCommunityNarratives());
    expect(store.selectSnapshot(CommunityNarrativesState.loadStatus)).toBe('error');
    expect(store.selectSnapshot(CommunityNarrativesState.error)).toContain('Could not load');
  });

  it('regenerates one community with its slug, keeps the counts, and reloads', () => {
    store.dispatch(new RegenerateCommunityNarratives('altadore'));
    expect(api.regenerateCommunityNarratives).toHaveBeenCalledWith({ community_slug: 'altadore' });
    expect(store.selectSnapshot(CommunityNarrativesState.lastResult)).toEqual({
      response: RESULT,
      slug: 'altadore',
    });
    expect(store.selectSnapshot(CommunityNarrativesState.regenerating)).toBeNull();
    expect(api.getCommunityNarratives).toHaveBeenCalledTimes(1);
  });

  it('regenerates all communities with an empty body', () => {
    store.dispatch(new RegenerateCommunityNarratives());
    expect(api.regenerateCommunityNarratives).toHaveBeenCalledWith({});
    expect(store.selectSnapshot(CommunityNarrativesState.lastResult)?.slug).toBeNull();
  });

  it('ignores a second regenerate while one is in flight', () => {
    api.regenerateCommunityNarratives.mockReturnValue(NEVER);
    store.dispatch(new RegenerateCommunityNarratives());
    store.dispatch(new RegenerateCommunityNarratives('altadore'));
    expect(api.regenerateCommunityNarratives).toHaveBeenCalledTimes(1);
    expect(store.selectSnapshot(CommunityNarrativesState.regenerating)).toEqual({ scope: 'all' });
  });

  it('reports a regenerate failure without touching the list', () => {
    store.dispatch(new LoadCommunityNarratives());
    api.regenerateCommunityNarratives.mockReturnValue(throwError(() => new Error('nope')));
    store.dispatch(new RegenerateCommunityNarratives('altadore'));
    expect(store.selectSnapshot(CommunityNarrativesState.regenerateError)).toContain('Could not regenerate');
    expect(store.selectSnapshot(CommunityNarrativesState.regenerating)).toBeNull();
    expect(store.selectSnapshot(CommunityNarrativesState.communities)).toEqual([ROW]);
  });
});
