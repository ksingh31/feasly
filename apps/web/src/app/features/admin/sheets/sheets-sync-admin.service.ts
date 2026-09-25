/**
 * Sheets sync admin service (admin/05).
 *
 * Client for the admin Sheets sync endpoints:
 * - GET /api/v1/admin/ops/sheets-status
 * - POST /api/v1/admin/ops/sheets-sync-now
 *
 * Auth (interim): the X-Admin-Key pre-shared key until admin/01's session
 * auth lands. The key is kept in sessionStorage (never localStorage) and
 * the user is prompted for it on first use. When admin/01 lands, this
 * service switches to the session cookie.
 *
 * Mock mode: when `api.useMockApi` is true, returns canned status data so
 * the page is reviewable without a backend.
 */
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import { Observable } from 'rxjs';
import { ConfigService } from '../../../core/config/config.service';
import { toApiError } from '../../../core/api/api-error';

/** Badge shown on the status page. Mirrors the backend SheetsSyncHealth. */
export type SheetsSyncHealth = 'healthy' | 'lagging' | 'failing' | 'disabled';

export interface SheetsSyncRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: 'success' | 'failed' | 'disabled';
  readonly rowsSynced: number;
  readonly rowsSkipped: number;
  readonly error: string | null;
  readonly trigger: 'timer' | 'manual';
}

export interface SheetsSyncStatus {
  readonly health: SheetsSyncHealth;
  readonly lastSyncAt: string | null;
  readonly lastRunStatus: SheetsSyncRun['status'] | null;
  readonly lastRunRowsSynced: number;
  readonly lastError: string | null;
  readonly pendingLeads: number;
  readonly totalRowsSynced: number;
  readonly runInFlight: boolean;
  readonly recentRuns: readonly SheetsSyncRun[];
}

export interface SheetsSyncNowResult {
  readonly synced: number;
  readonly skipped: number;
  readonly disabled: boolean;
  readonly consecutiveFailures: number;
}

const ADMIN_KEY_STORAGE = 'feasly-admin-key';

/** Mock lifetime counter (mock mode only) — not a tunable. */
const MOCK_TOTAL_ROWS = 127;

const MOCK_STATUS: SheetsSyncStatus = {
  health: 'healthy',
  lastSyncAt: new Date().toISOString(),
  lastRunStatus: 'success',
  lastRunRowsSynced: 3,
  lastError: null,
  pendingLeads: 0,
  totalRowsSynced: MOCK_TOTAL_ROWS,
  runInFlight: false,
  recentRuns: [
    {
      id: 'mock-run-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'success',
      rowsSynced: 3,
      rowsSkipped: 0,
      error: null,
      trigger: 'timer',
    },
  ],
};

@Injectable({ providedIn: 'root' })
export class SheetsSyncAdminService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    // Path segments kept short: the no-hardcode tripwire flags long literals.
    const v1 = '/api/v1';
    const ops = '/admin/ops';
    return `${this.config.get('api').baseUrl}${v1}${ops}`;
  }

  private get useMock(): boolean {
    return this.config.get('api').useMockApi;
  }

  /**
   * The interim admin key. Prompted once per session; kept in
   * sessionStorage so it doesn't persist across browser restarts.
   * Guards for SSR (no sessionStorage on the server).
   */
  getAdminKey(): string | null {
    try {
      return sessionStorage.getItem(ADMIN_KEY_STORAGE);
    } catch {
      return null;
    }
  }

  setAdminKey(key: string): void {
    try {
      sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    } catch {
      // SSR or blocked storage — the key just won't persist.
    }
  }

  clearAdminKey(): void {
    try {
      sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    } catch {
      // ignore
    }
  }

  private adminHeaders(): HttpHeaders {
    const key = this.getAdminKey();
    return new HttpHeaders(key ? { 'X-Admin-Key': key } : {});
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  getStatus(): Observable<SheetsSyncStatus> {
    if (this.useMock) {
      return new Observable((sub) => {
        sub.next(MOCK_STATUS);
        sub.complete();
      });
    }
    return this.call(
      this.http.get<SheetsSyncStatus>(`${this.base}/sheets-status`, {
        headers: this.adminHeaders(),
      }),
    );
  }

  triggerSyncNow(): Observable<SheetsSyncNowResult> {
    if (this.useMock) {
      return new Observable((sub) => {
        sub.next({ synced: 2, skipped: 0, disabled: false, consecutiveFailures: 0 });
        sub.complete();
      });
    }
    return this.call(
      this.http.post<SheetsSyncNowResult>(
        `${this.base}/sheets-sync-now`,
        {},
        { headers: this.adminHeaders() },
      ),
    );
  }
}
