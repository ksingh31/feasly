import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import type { DisputeDetailResponse, DisputeListItem } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AdminDisputesComponent } from './admin-disputes.component';
import { AdminDisputesState } from './admin-disputes.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const DISPUTE_A: DisputeListItem = {
  id: 'd1',
  invoiceId: 'inv-1',
  tenantKey: 'elite-craft',
  reason: 'Contract value reported twice',
  status: 'open',
  openedAt: '2026-09-25T12:00:00.000Z',
  slaDueAt: '2026-10-02T12:00:00.000Z',
  slaBreachedAt: null,
  commissionCents: 10000,
  currency: 'CAD',
  contractValueCents: 1000000,
  businessDaysRemaining: 4,
  breached: false,
};

const DETAIL_A: DisputeDetailResponse = {
  ...DISPUTE_A,
  evidenceSnapshot: {
    invoiceId: 'inv-1',
    tenantKey: 'elite-craft',
    attributionId: 'attr-1',
    leadId: 'lead-1',
    contractValueCents: 1000000,
    commissionCents: 10000,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status: 'disputed',
    reviewDueAt: null,
    disputeReason: 'Contract value reported twice',
    invoiceCreatedAt: '2026-09-20T10:00:00.000Z',
    disputedAt: '2026-09-25T12:00:00.000Z',
  },
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  auditTrail: [],
};

/**
 * AdminDisputesComponent permission gating (QA admin-console finding 8):
 * the Resolve section (accept/reject) is a billing:manage write — viewers
 * see the dispute evidence and audit trail but no resolution UI.
 */
describe('AdminDisputesComponent permission gating', () => {
  let store: Store;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<AdminDisputesComponent>;

  async function setup(permissions: string[]): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminDisputesComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        // AdminAuthState is in the root store in production (app.config.ts).
        provideStore([AdminDisputesState, AdminAuthState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
    store.reset({
      adminDisputes: store.selectSnapshot((s) => s.adminDisputes),
      adminAuth: {
        ...store.selectSnapshot((s) => s.adminAuth),
        permissions,
      },
    });
    fixture = TestBed.createComponent(AdminDisputesComponent);
  }

  /** Loads the list, opens the dispute detail, and renders. */
  async function openDispute(): Promise<void> {
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/disputes') && r.method === 'GET')
      .flush({ disputes: [DISPUTE_A] });
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.debugElement
      .query(By.css('.disputes-page__row'))
      ?.nativeElement.click();
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1') && r.method === 'GET')
      .flush(DETAIL_A);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('shows the Resolve section with accept/reject to billing managers', async () => {
    await setup([ADMIN_PERMISSIONS.billingManage]);
    await openDispute();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Resolve');
    expect(page.querySelector('.disputes-page__accept')).not.toBeNull();
    expect(page.querySelector('.disputes-page__reject')).not.toBeNull();
  });

  it('hides the Resolve section from viewers but keeps the dispute readable', async () => {
    await setup([]);
    await openDispute();

    const page = fixture.nativeElement as HTMLElement;
    // The dispute evidence stays visible (read-only).
    expect(page.textContent).toContain('Contract value reported twice');
    expect(page.textContent).toContain('Audit trail');
    // The write UI is gone.
    expect(page.textContent).not.toContain('Resolve');
    expect(page.querySelector('.disputes-page__accept')).toBeNull();
    expect(page.querySelector('.disputes-page__reject')).toBeNull();
    expect(page.querySelector('.disputes-page__resolve-actions')).toBeNull();
  });
});
