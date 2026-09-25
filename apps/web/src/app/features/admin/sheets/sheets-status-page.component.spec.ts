import { TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetsStatusPageComponent } from './sheets-status-page.component';
import {
  SheetsSyncAdminService,
  type SheetsSyncStatus,
} from './sheets-sync-admin.service';

/**
 * admin/05: the Sheets status page shows the health badge, prompts for the
 * interim admin key when missing, disables "Sync now" while a run is in
 * flight, and surfaces load errors with a retry.
 */
describe('SheetsStatusPageComponent', () => {
  const HEALTHY: SheetsSyncStatus = {
    health: 'healthy',
    lastSyncAt: '2026-09-25T12:00:00.000Z',
    lastRunStatus: 'success',
    lastRunRowsSynced: 5,
    lastError: null,
    pendingLeads: 0,
    totalRowsSynced: 42,
    runInFlight: false,
    recentRuns: [],
  };

  let admin: {
    getAdminKey: ReturnType<typeof vi.fn>;
    setAdminKey: ReturnType<typeof vi.fn>;
    clearAdminKey: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    triggerSyncNow: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // sessionStorage isn't defined in the vitest node environment — stub it.
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    });
    admin = {
      getAdminKey: vi.fn().mockReturnValue('key'),
      setAdminKey: vi.fn(),
      clearAdminKey: vi.fn(),
      getStatus: vi.fn().mockReturnValue(of(HEALTHY)),
      triggerSyncNow: vi.fn().mockReturnValue(of({ synced: 1, skipped: 0, disabled: false, consecutiveFailures: 0 })),
    };
  });

  async function setup() {
    await TestBed.configureTestingModule({
      imports: [RouterTestingModule, SheetsStatusPageComponent],
      providers: [
        { provide: SheetsSyncAdminService, useValue: admin },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SheetsStatusPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('renders the Healthy badge and stats', async () => {
    const { el } = await setup();
    expect(el.querySelector('.badge')?.textContent?.trim()).toBe('Healthy');
    expect(el.textContent).toContain('42');
  });

  it('prompts for the admin key when none is stored', async () => {
    admin.getAdminKey.mockReturnValue(null);
    const { el } = await setup();
    expect(el.querySelector('.key-prompt')).not.toBeNull();
    expect(admin.getStatus).not.toHaveBeenCalled();
  });

  it('disables Sync now while a run is in flight', async () => {
    admin.getStatus.mockReturnValue(of({ ...HEALTHY, runInFlight: true }));
    const { el } = await setup();
    const btn = el.querySelector('button.sync-now') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('in progress');
  });

  it('shows the Lagging badge on consecutive failures', async () => {
    admin.getStatus.mockReturnValue(
      of({ ...HEALTHY, health: 'lagging', lastError: 'Error: 503' }),
    );
    const { el } = await setup();
    expect(el.querySelector('.badge')?.textContent?.trim()).toBe('Lagging');
    expect(el.textContent).toContain('Error: 503');
  });

  it('shows an error with retry when loading fails', async () => {
    admin.getStatus.mockReturnValue(throwError(() => new Error('boom')));
    const { el, fixture } = await setup();
    expect(el.querySelector('.error')).not.toBeNull();
    // Retry re-calls getStatus.
    (el.querySelector('.error button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(admin.getStatus).toHaveBeenCalledTimes(2);
  });
});
