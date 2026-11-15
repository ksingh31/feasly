/**
 * Admin Disputes queue (#545, admin review S12): kit DataTable with the
 * SLA chip (AC1), breached rows flagged, and a row click opening the
 * dispute drawer (`?open=<id>`).
 */
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisputeListItem } from '@feasly/contracts';
import { UiDrawerService } from '@app/shared/ui';
import { AdminDisputesComponent } from './admin-disputes.component';
import { AdminDisputesApiService } from './admin-disputes-api.service';
import { AdminDisputesState } from './admin-disputes.state';
import { AdminAuthState } from './admin-auth.state';

function dispute(id: string, businessDaysRemaining: number, breached = false): DisputeListItem {
  return {
    id,
    invoiceId: `inv-${id}`,
    tenantKey: 'elite-craft',
    reason: 'Contract value reported twice',
    status: 'open',
    openedAt: '2026-09-25T12:00:00.000Z',
    slaDueAt: '2026-10-02T12:00:00.000Z',
    slaBreachedAt: breached ? '2026-10-02T12:00:00.000Z' : null,
    commissionCents: 980000,
    currency: 'CAD',
    contractValueCents: 98000000,
    businessDaysRemaining,
    breached,
  };
}

const ROWS = [dispute('d1', 4), dispute('d2', 0), dispute('d3', -1, true)];

async function setup(options: { fails?: boolean; url?: string } = {}) {
  const api = {
    listDisputes: vi.fn(() =>
      options.fails ? throwError(() => ({ message: 'Server down' })) : of({ disputes: ROWS }),
    ),
    getDispute: vi.fn(() => new Subject()),
    acceptDispute: vi.fn(),
    rejectDispute: vi.fn(),
  };
  const closed = new Subject<unknown>();
  const drawers = { open: vi.fn(() => ({ closed: closed.asObservable() })) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: AdminDisputesComponent }]),
      provideLocationMocks(),
      provideStore([AdminDisputesState, AdminAuthState]),
      { provide: AdminDisputesApiService, useValue: api },
      { provide: UiDrawerService, useValue: drawers },
    ],
  });
  if (options.url) await TestBed.inject(Router).navigateByUrl(options.url);
  const fixture = TestBed.createComponent(AdminDisputesComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  return { api, drawers, closed, fixture, store: TestBed.inject(Store), el: fixture.nativeElement as HTMLElement };
}

afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

describe('AdminDisputesComponent (#545)', () => {
  it('renders the queue in a DataTable with Opened · Invoice · Builder · Amount · Reason · SLA', async () => {
    const { el } = await setup();
    const headers = Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Opened', 'Invoice', 'Builder', 'Amount', 'Reason', 'SLA']);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(el.querySelector('tbody')?.textContent).toContain('$9,800');
    expect(el.querySelector('[data-testid="disputes-count"]')?.textContent).toContain('3 open disputes');
  });

  it('SLA chip: days left / due today / overdue (AC1)', async () => {
    const { el } = await setup();
    const chips = Array.from(el.querySelectorAll('tbody [data-testid="sla-chip"]')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['4 days left', 'Due today', 'Overdue 1d']);
  });

  it('flags breached rows', async () => {
    const { el } = await setup();
    const rows = Array.from(el.querySelectorAll('tbody tr'));
    const flagged = rows.map((r) => r.className.includes('flag'));
    expect(flagged).toEqual([false, false, true]);
  });

  it('a row click opens the dispute drawer with ?open=<id>', async () => {
    const { el, drawers, store } = await setup();
    (el.querySelectorAll('tbody tr')[1] as HTMLElement).click();
    expect(drawers.open).toHaveBeenCalledTimes(1);
    const [, options] = drawers.open.mock.calls[0] as unknown as [unknown, { urlId: string; data: unknown }];
    expect(options.urlId).toBe('d2');
    expect(options.data).toEqual({ disputeId: 'd2' });
    expect(store.selectSnapshot(AdminDisputesState.selectedDisputeId)).toBe('d2');
  });

  it('closing the drawer clears the selection', async () => {
    const { el, closed, store } = await setup();
    (el.querySelectorAll('tbody tr')[0] as HTMLElement).click();
    closed.next(undefined);
    expect(store.selectSnapshot(AdminDisputesState.selectedDisputeId)).toBeNull();
  });

  it('a deep link with ?open=<id> opens the drawer', async () => {
    const { drawers } = await setup({ url: '/admin/disputes?open=d3' });
    expect(drawers.open).toHaveBeenCalled();
    const [, options] = drawers.open.mock.calls[0] as unknown as [unknown, { urlId: string }];
    expect(options.urlId).toBe('d3');
  });

  it('a load failure shows the error state, and Retry reloads', async () => {
    const { el, api } = await setup({ fails: true });
    expect(el.textContent).toContain('Couldn’t load disputes');
    const retry = Array.from(el.querySelectorAll('ui-data-table button')).find((b) => b.textContent?.trim() === 'Retry');
    (retry as HTMLButtonElement).click();
    expect(api.listDisputes).toHaveBeenCalledTimes(2);
  });
});
