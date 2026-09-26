import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SheetsSyncStatusResponse } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  LoadSheetsSyncStatus,
  TriggerSheetsSyncNow,
} from './sheets-sync.actions';
import { SheetsSyncState, sheetsSyncBadgeFor } from './sheets-sync.state';

const STATUS_URL = '/api/v1/admin/ops/sheets-status';
const SYNC_NOW_URL = '/api/v1/admin/ops/sheets-sync-now';

function makeStatus(
  overrides: Partial<SheetsSyncStatusResponse> = {},
): SheetsSyncStatusResponse {
  return {
    last_run_at: '2026-09-26T00:00:00.000Z',
    last_success_at: '2026-09-26T00:00:00.000Z',
    rows_synced_total: 42,
    pending_count: 3,
    consecutive_failures: 0,
    lagging: false,
    run_in_flight: false,
    sheets_configured: true,
    recent_failures: [],
    ...overrides,
  };
}

/**
 * SheetsSyncState (admin/05): single source of truth for the
 * /admin/ops/sheets panel. Components never call the API directly.
 */
describe('SheetsSyncState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([SheetsSyncState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { useMockApi: true, baseUrl: '', timeoutMs: 5000 },
    });
    await pending;
    store = TestBed.inject(Store);
  }

  beforeEach(async () => {
    await setup();
  });

  it('badge: failing when consecutive_failures >= 3 (AC2)', () => {
    expect(
      sheetsSyncBadgeFor(makeStatus({ consecutive_failures: 3, lagging: true })),
    ).toBe('failing');
  });

  it('badge: lagging when the backend reports lag (AC2)', () => {
    expect(
      sheetsSyncBadgeFor(makeStatus({ consecutive_failures: 0, lagging: true })),
    ).toBe('lagging');
  });

  it('badge: healthy otherwise (AC2)', () => {
    expect(
      sheetsSyncBadgeFor(makeStatus({ consecutive_failures: 0, lagging: false })),
    ).toBe('healthy');
    expect(sheetsSyncBadgeFor(null)).toBeNull();
  });

  it('LoadSheetsSyncStatus stores the payload and badge', async () => {
    const pending = store.dispatch(new LoadSheetsSyncStatus());
    httpMock.expectOne(STATUS_URL).flush(makeStatus({ pending_count: 7 }));
    await pending;

    expect(store.selectSnapshot(SheetsSyncState.status)?.pending_count).toBe(7);
    expect(store.selectSnapshot(SheetsSyncState.badge)).toBe('healthy');
    expect(store.selectSnapshot(SheetsSyncState.loadStatus)).toBe('ready');
  });

  it('load failure sets an error without leaking the raw error', async () => {
    const pending = store.dispatch(new LoadSheetsSyncStatus());
    httpMock
      .expectOne(STATUS_URL)
      .error(new ProgressEvent('error'), { status: 500 });
    await pending;

    expect(store.selectSnapshot(SheetsSyncState.loadStatus)).toBe('error');
    const error = store.selectSnapshot(SheetsSyncState.error);
    expect(error).toBeTruthy();
    expect(error).not.toContain('500');
  });

  it('TriggerSheetsSyncNow posts and reloads the status (AC3)', async () => {
    const pending = store.dispatch(new TriggerSheetsSyncNow());
    const triggerReq = httpMock.expectOne(SYNC_NOW_URL);
    expect(triggerReq.request.method).toBe('POST');
    expect(store.selectSnapshot(SheetsSyncState.triggering)).toBe(true);
    triggerReq.flush({
      synced: 3,
      skipped: 1,
      disabled: false,
      triggered_at: '2026-09-26T01:00:00.000Z',
    });
    // The trigger handler reloads the status.
    httpMock.expectOne(STATUS_URL).flush(makeStatus());
    await pending;

    expect(store.selectSnapshot(SheetsSyncState.triggering)).toBe(false);
    expect(store.selectSnapshot(SheetsSyncState.lastTrigger)?.synced).toBe(3);
    expect(store.selectSnapshot(SheetsSyncState.loadStatus)).toBe('ready');
  });

  it('TriggerSheetsSyncNow is a no-op while a run is in flight (AC3)', async () => {
    const load = store.dispatch(new LoadSheetsSyncStatus());
    httpMock.expectOne(STATUS_URL).flush(makeStatus({ run_in_flight: true }));
    await load;

    expect(store.selectSnapshot(SheetsSyncState.syncNowDisabled)).toBe(true);
    await store.dispatch(new TriggerSheetsSyncNow());
    httpMock.expectNone(SYNC_NOW_URL);
  });

  it('a 409 reloads the status instead of erroring out (AC3)', async () => {
    const pending = store.dispatch(new TriggerSheetsSyncNow());
    // The real backend answers 409 with a ProblemDetails body (code CONFLICT).
    httpMock
      .expectOne(SYNC_NOW_URL)
      .flush(
        { code: 'CONFLICT', message: 'A Sheets sync run is already in flight.' },
        { status: 409, statusText: 'Conflict' },
      );
    httpMock.expectOne(STATUS_URL).flush(makeStatus({ run_in_flight: true }));
    await pending;

    expect(store.selectSnapshot(SheetsSyncState.triggering)).toBe(false);
    expect(store.selectSnapshot(SheetsSyncState.status)?.run_in_flight).toBe(
      true,
    );
  });
});
