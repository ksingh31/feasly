import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSearchResponse } from '@feasly/contracts';
import { AdminSearchApiService } from './admin-search-api.service';
import { ClearAdminSearch, SearchAdmin } from './admin-search.actions';
import { AdminSearchState } from './admin-search.state';

const HIT = { kind: 'lead' as const, id: 'l-1', label: 'Jordan Lee', sublabel: null };

describe('AdminSearchState (#538)', () => {
  let store: Store;
  let api: { search: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = { search: vi.fn().mockReturnValue(of({ query: 'jor', hits: [HIT] })) };
    TestBed.configureTestingModule({
      providers: [provideStore([AdminSearchState]), { provide: AdminSearchApiService, useValue: api }],
    });
    store = TestBed.inject(Store);
  });

  it('stores trimmed-query hits per scope', async () => {
    await firstValueFrom(store.dispatch(new SearchAdmin('palette', '  jor ')));
    expect(api.search).toHaveBeenCalledWith('jor');
    expect(store.selectSnapshot(AdminSearchState.palette)).toEqual({
      query: 'jor',
      hits: [HIT],
      status: 'ready',
      error: null,
    });
    expect(store.selectSnapshot(AdminSearchState.leadPicker).status).toBe('idle');
  });

  it('an empty query clears without calling the API', async () => {
    await firstValueFrom(store.dispatch(new SearchAdmin('palette', 'jor')));
    store.dispatch(new SearchAdmin('palette', '   '));
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(store.selectSnapshot(AdminSearchState.palette).hits).toEqual([]);
  });

  it('a newer search cancels the in-flight one (no stale overwrite)', () => {
    const first = new Subject<AdminSearchResponse>();
    const second = new Subject<AdminSearchResponse>();
    api.search.mockReturnValueOnce(first).mockReturnValueOnce(second);
    store.dispatch(new SearchAdmin('palette', 'jo'));
    store.dispatch(new SearchAdmin('palette', 'jor'));
    second.next({ query: 'jor', hits: [HIT] });
    second.complete();
    first.next({ query: 'jo', hits: [] });
    expect(store.selectSnapshot(AdminSearchState.palette)).toMatchObject({ query: 'jor', hits: [HIT] });
  });

  it('records errors and clears on ClearAdminSearch', async () => {
    api.search.mockReturnValue(throwError(() => ({ message: 'Too many requests' })));
    await firstValueFrom(store.dispatch(new SearchAdmin('leadPicker', 'x'))).catch(() => undefined);
    expect(store.selectSnapshot(AdminSearchState.leadPicker)).toMatchObject({
      status: 'error',
      error: 'Too many requests',
    });
    store.dispatch(new ClearAdminSearch('leadPicker'));
    expect(store.selectSnapshot(AdminSearchState.leadPicker).status).toBe('idle');
  });
});
