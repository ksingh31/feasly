/**
 * Sheets sync ops panel (admin/05, kit migration #547).
 *
 * Verifies: header health chip (incl. "Not started" when the worker never
 * ran — review B18), Sync now kit button with a running state, KPI tiles
 * with kit-formatted counts and dates (no raw ISO, no seconds), failures
 * Timeline, and that every control is a kit control.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { NEVER, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SheetsSyncStatusResponse } from '@feasly/contracts';
import { AdminOpsApiService } from './admin-ops-api.service';
import { AdminSheetsStatusComponent } from './admin-sheets-status.component';
import { TriggerSheetsSyncNow } from './sheets-sync.actions';
import { SheetsSyncState } from './sheets-sync.state';

function makeStatus(
  overrides: Partial<SheetsSyncStatusResponse> = {},
): SheetsSyncStatusResponse {
  return {
    last_run_at: '2026-07-12T17:30:45.000Z',
    last_success_at: '2026-07-12T17:30:45.000Z',
    rows_synced_total: 1843,
    pending_count: 4820,
    consecutive_failures: 0,
    lagging: false,
    run_in_flight: false,
    sheets_configured: true,
    recent_failures: [],
    ...overrides,
  };
}

async function setup(status: SheetsSyncStatusResponse | null = makeStatus()) {
  TestBed.resetTestingModule();
  const api = {
    getSheetsStatus: vi.fn().mockReturnValue(status ? of(status) : NEVER),
    triggerSheetsSyncNow: vi.fn().mockReturnValue(NEVER),
  };
  TestBed.configureTestingModule({
    imports: [AdminSheetsStatusComponent],
    providers: [provideStore([SheetsSyncState]), { provide: AdminOpsApiService, useValue: api }],
  });
  const fixture: ComponentFixture<AdminSheetsStatusComponent> =
    TestBed.createComponent(AdminSheetsStatusComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api, store: TestBed.inject(Store), el: fixture.nativeElement as HTMLElement };
}

function chipText(el: HTMLElement): string | undefined {
  return el.querySelector('.sheets-page__health ui-status-chip')?.textContent?.trim();
}

describe('AdminSheetsStatusComponent (#547)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows a Healthy chip in the page header for a healthy worker', async () => {
    const { el } = await setup();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Sheets sync');
    expect(chipText(el)).toBe('Healthy');
    // The badge legend moved into the ⓘ tooltip next to the chip.
    expect(el.querySelector('.sheets-page__health app-info-tooltip')).not.toBeNull();
  });

  it('says "Not started" (not "Healthy") when the worker never ran (review B18)', async () => {
    const { el } = await setup(makeStatus({ last_run_at: null, last_success_at: null }));
    expect(chipText(el)).toBe('Not started');
    expect(el.textContent).toContain('No runs yet');
  });

  it('shows Failing at 3+ consecutive failures with a danger KPI tone', async () => {
    const { el } = await setup(makeStatus({ consecutive_failures: 3 }));
    expect(chipText(el)).toBe('Failing');
    expect(el.querySelector('.kpi--danger')).not.toBeNull();
  });

  it('formats counts and dates through the kit pipes', async () => {
    const { el } = await setup();
    const text = el.textContent ?? '';
    expect(text).toContain('1,843');
    expect(text).toContain('4,820');
    expect(text).toContain('Jul 12, 2026 · 11:30 a.m. MT');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/\d:\d{2}:\d{2}/);
  });

  it('renders five KPI tiles — "Run in flight" is the button state, not a tile', async () => {
    const { el } = await setup(makeStatus({ run_in_flight: true }));
    expect(el.querySelectorAll('ui-kpi-tile').length).toBe(5);
    expect(el.textContent).not.toContain('Run in flight');
    const button = el.querySelector('[data-testid="sync-now"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Running…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
  });

  it('dispatches a manual sync from the Sync now kit button', async () => {
    const { el, store } = await setup();
    const dispatch = vi.spyOn(store, 'dispatch');
    const button = el.querySelector('[data-testid="sync-now"]') as HTMLButtonElement;
    expect(button.classList).toContain('ui-button');
    expect(button.textContent?.trim()).toBe('Sync now');
    button.click();
    expect(dispatch).toHaveBeenCalledWith(expect.any(TriggerSheetsSyncNow));
  });

  it('lists recent failures on a Timeline', async () => {
    const { el } = await setup(
      makeStatus({
        consecutive_failures: 1,
        recent_failures: [{ at: '2026-07-12T16:00:00.000Z', error: 'Sheets API quota exceeded' }],
      }),
    );
    const timeline = el.querySelector('ui-timeline');
    expect(timeline?.textContent).toContain('Sheets API quota exceeded');
    expect(timeline?.textContent).not.toContain('2026-07-12T');
  });

  it('warns when Sheets is not configured', async () => {
    const { el } = await setup(makeStatus({ sheets_configured: false }));
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Sheets is not configured.');
  });

  it('uses only kit controls — no unstyled native buttons', async () => {
    const { el } = await setup(
      makeStatus({ recent_failures: [{ at: '2026-07-12T16:00:00.000Z', error: 'x' }] }),
    );
    const buttons = Array.from(el.querySelectorAll('button')).filter(
      (b) => !b.closest('ui-timeline, app-info-tooltip, ui-error-state'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.classList).toContain('ui-button');
  });

  it('shows a skeleton while the first load is in flight', async () => {
    const { el } = await setup(null);
    expect(el.querySelector('ui-skeleton')).not.toBeNull();
    expect(el.querySelector('[data-testid="sync-now"]')).toBeNull();
  });
});
