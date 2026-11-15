import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { Builder } from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { BillingHealthState } from './billing-health.state';
import { AdminBuildersState } from './admin-builders.state';
import { AdminSearchApiService } from './admin-search-api.service';
import { AdminSearchState } from './admin-search.state';
import {
  AdminCreateInvoiceComponent,
  toIsoWithOffset,
} from './admin-create-invoice.component';

const BUILDERS: Builder[] = [
  {
    tenantKey: 'test-builder',
    displayName: 'Test Builder',
    businessName: 'Test Builder Inc.',
    plan: 'commission',
    status: 'active',
    commissionRatePercent: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  } as Builder,
  {
    tenantKey: 'custom-rate-builder',
    displayName: 'Custom Rate Builder',
    businessName: 'Custom Rate Builder Inc.',
    plan: 'commission',
    status: 'active',
    commissionRatePercent: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  } as Builder,
];

const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_RESPONSE = {
  invoiceId: '33333333-3333-4333-8333-333333333333',
  status: 'in_review' as const,
  tenantKey: 'test-builder',
  leadId: LEAD_ID,
  contractValueCents: 85_000_000,
  commissionCents: 850_000,
  currency: 'CAD',
  reviewDueAt: '2026-09-27T14:30:00.000Z',
};

function fillValidForm(
  component: AdminCreateInvoiceComponent,
): void {
  component.form.controls.builder.setValue('test-builder');
  component.form.controls.leadId.setValue(LEAD_ID);
  component.form.controls.contractDollars.setValue(850_000);
  component.form.controls.signedDate.setValue('2026-09-20');
}

describe('AdminCreateInvoiceComponent (manual invoice creation)', () => {
  let fixture: ComponentFixture<AdminCreateInvoiceComponent>;
  let component: AdminCreateInvoiceComponent;
  let searchApi: { search: ReturnType<typeof vi.fn> };
  let billingApi: {
    getBillingHealth: ReturnType<typeof vi.fn>;
    retryInvoiceCharge: ReturnType<typeof vi.fn>;
    createManualInvoice: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    billingApi = {
      getBillingHealth: vi.fn().mockReturnValue(of(null)),
      retryInvoiceCharge: vi.fn().mockReturnValue(of(null)),
      createManualInvoice: vi.fn().mockReturnValue(of(INVOICE_RESPONSE)),
    };
    searchApi = {
      search: vi.fn().mockReturnValue(
        of({
          query: 'jordan',
          hits: [
            { kind: 'lead', id: LEAD_ID, label: 'Jordan Lee', sublabel: '12 Elm St SW' },
            { kind: 'builder', id: 'b-1', label: 'Test Builder', sublabel: 'test-builder' },
          ],
        }),
      ),
    };
    const buildersApi = {
      listBuilders: vi.fn().mockReturnValue(of({ builders: BUILDERS })),
    };
    await TestBed.configureTestingModule({
      imports: [AdminCreateInvoiceComponent],
      providers: [
        provideStore([BillingHealthState, AdminBuildersState, AdminSearchState]),
        { provide: AdminSearchApiService, useValue: searchApi },
        { provide: AdminBillingApiService, useValue: billingApi },
        { provide: AdminBuildersApiService, useValue: buildersApi },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminCreateInvoiceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads the builders for the picker on init', () => {
    const store = TestBed.inject(Store);
    expect(store.selectSnapshot(AdminBuildersState.builders)).toEqual(
      BUILDERS,
    );
  });

  it('blocks the review step while the form is invalid', () => {
    component.form.controls.leadId.setValue('not-a-uuid');
    component.startReview();
    expect(component.reviewing()).toBe(false);
    expect(component.form.invalid).toBe(true);
  });

  it('shows the review step with the calculated 1% figure when valid', () => {
    fillValidForm(component);
    component.startReview();
    fixture.detectChanges();
    expect(component.reviewing()).toBe(true);
    expect(component.contractValueCents()).toBe(85_000_000);
    expect(component.estimatedCommissionCents()).toBe(850_000);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Review invoice');
    expect(text).toContain('$8,500');
    expect(text).toContain('7-day builder review window');
  });

  it('estimates the review-step commission at the selected builder\u2019s rate (billing/08)', () => {
    component.form.controls.builder.setValue('custom-rate-builder');
    component.form.controls.leadId.setValue(LEAD_ID);
    component.form.controls.contractDollars.setValue(850_000);
    component.form.controls.signedDate.setValue('2026-09-20');
    component.startReview();
    fixture.detectChanges();

    expect(component.reviewing()).toBe(true);
    // $850,000 × 2% = $17,000 — the estimate follows the builder's
    // negotiated rate, not the 1% default.
    expect(component.estimatedCommissionCents()).toBe(1_700_000);
    expect(component.selectedRateLabel()).toBe('2%');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('$17,000');
  });

  it('dispatches the create with integer cents and an offset ISO datetime', async () => {
    fillValidForm(component);
    component.startReview();
    component.confirmCreate();
    await fixture.whenStable();
    expect(billingApi.createManualInvoice).toHaveBeenCalledTimes(1);
    const body = billingApi.createManualInvoice.mock.calls[0][0];
    expect(body.tenantKey).toBe('test-builder');
    expect(body.leadId).toBe(LEAD_ID);
    expect(body.contractValueCents).toBe(85_000_000);
    // Explicit dollars → cents conversion, ISO with timezone offset.
    expect(body.contractSignedAt).toMatch(
      /^2026-09-20T12:00:00[+-]\d{2}:\d{2}$/,
    );
  });

  it('shows the confirmation with the server figures on success', async () => {
    fillValidForm(component);
    component.startReview();
    component.confirmCreate();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.confirmedInvoice()).toEqual(INVOICE_RESPONSE);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invoice created');
    expect(text).toContain('in_review');
    expect(text).toContain('$8,500');
  });

  it('shows a friendly error when the lead is not found', async () => {
    billingApi.createManualInvoice.mockReturnValue(
      throwError(() => ({ status: 404 })),
    );
    fillValidForm(component);
    component.startReview();
    component.confirmCreate();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('lead id was not found');
  });

  it('shows a friendly error when the signing date is outside the attribution window', async () => {
    billingApi.createManualInvoice.mockReturnValue(
      throwError(() => ({
        status: 422,
        error: { code: 'VALIDATION_FAILED' },
      })),
    );
    fillValidForm(component);
    component.startReview();
    component.confirmCreate();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('outside the 12-month attribution window');
  });
  describe('lead picker (#538)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('replaces the paste-a-UUID field with a lead search combobox', () => {
      const input = fixture.nativeElement.querySelector(
        '.create-invoice__lead input[role="combobox"]',
      ) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain('UUID');
    });

    it('searches leads (debounced) and lists only lead hits', () => {
      const input = fixture.nativeElement.querySelector(
        '.create-invoice__lead input',
      ) as HTMLInputElement;
      input.value = 'jordan';
      input.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(100);
      expect(searchApi.search).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      fixture.detectChanges();
      expect(searchApi.search).toHaveBeenCalledWith('jordan');
      expect(component.leadOptions()).toEqual([
        { id: LEAD_ID, label: 'Jordan Lee', meta: '12 Elm St SW' },
      ]);
      const options = Array.from(
        fixture.nativeElement.querySelectorAll('.create-invoice__lead [role="option"]'),
      ) as HTMLElement[];
      expect(options.map((o) => o.textContent?.trim())).toEqual([
        expect.stringContaining('Jordan Lee'),
      ]);
    });

    it('picking a lead sets the id as the value and shows its name on review', () => {
      const input = fixture.nativeElement.querySelector(
        '.create-invoice__lead input',
      ) as HTMLInputElement;
      input.value = 'jordan';
      input.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(300);
      fixture.detectChanges();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
      expect(component.form.controls.leadId.value).toBe(LEAD_ID);

      component.form.controls.builder.setValue('test-builder');
      component.form.controls.contractDollars.setValue(850_000);
      component.form.controls.signedDate.setValue('2026-09-20');
      component.startReview();
      fixture.detectChanges();
      const review = fixture.nativeElement.querySelector('.create-invoice__review') as HTMLElement;
      expect(review.textContent).toContain('Jordan Lee');
      expect(review.textContent).not.toContain(LEAD_ID);
    });

    it('the confirmation links to the invoice instead of printing its UUID', async () => {
      vi.useRealTimers();
      fillValidForm(component);
      component.startReview();
      component.confirmCreate();
      await fixture.whenStable();
      fixture.detectChanges();
      const feedback = fixture.nativeElement.querySelector(
        '.create-invoice__feedback--ok',
      ) as HTMLElement;
      expect(feedback.querySelector('ui-entity-link')?.textContent).toContain('View invoice');
      expect(feedback.textContent).not.toContain(INVOICE_RESPONSE.invoiceId);
    });
  });
});

describe('toIsoWithOffset', () => {
  it('formats an ISO datetime with an explicit timezone offset', () => {
    const out = toIsoWithOffset(new Date(2026, 8, 20, 12, 0, 0));
    expect(out).toMatch(/^2026-09-20T12:00:00[+-]\d{2}:\d{2}$/);
  });

});
