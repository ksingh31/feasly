import { DialogRef } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { AdminLeadListItem, Builder } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { AdminLeadsApiService } from './admin-leads-api.service';
import { BillingHealthState } from './billing-health.state';
import { AdminBuildersState } from './admin-builders.state';
import {
  AdminCreateInvoiceComponent,
  builderOption,
  leadOption,
  toIsoWithOffset,
} from './admin-create-invoice.component';

const BUILDERS: Builder[] = [
  {
    id: 'b-1',
    tenantKey: 'test-builder',
    displayName: 'Test Builder',
    businessName: 'Test Builder Inc.',
    commissionRatePercent: 1,
  } as Builder,
  {
    id: 'b-2',
    tenantKey: 'custom-rate-builder',
    displayName: 'Custom Rate Builder',
    businessName: 'Custom Rate Builder Inc.',
    commissionRatePercent: 2,
  } as Builder,
];

const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const LEADS = [
  { id: LEAD_ID, name: 'Priya Shah', email: 'priya@example.com', addressKey: '123 Main St NW', status: 'won' },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Sam Lee', email: 'sam@example.com', addressKey: '9 Elm Ave SW', status: 'quoting' },
] as AdminLeadListItem[];

const INVOICE_RESPONSE = {
  invoiceId: '33333333-3333-4333-8333-333333333333',
  status: 'in_review' as const,
  tenantKey: 'custom-rate-builder',
  leadId: LEAD_ID,
  contractValueCents: 85_000_000,
  commissionCents: 1_700_000,
  currency: 'CAD',
  reviewDueAt: '2026-09-27T14:30:00.000Z',
};

async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('AdminCreateInvoiceComponent (#544 create-invoice modal)', () => {
  let fixture: ComponentFixture<AdminCreateInvoiceComponent>;
  let component: AdminCreateInvoiceComponent;
  let el: HTMLElement;
  let billingApi: { getBillingHealth: ReturnType<typeof vi.fn>; createManualInvoice: ReturnType<typeof vi.fn> };
  let leadsApi: { listLeads: ReturnType<typeof vi.fn> };
  let ref: { close: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    billingApi = {
      getBillingHealth: vi.fn().mockReturnValue(of(null)),
      createManualInvoice: vi.fn().mockReturnValue(of(INVOICE_RESPONSE)),
    };
    leadsApi = { listLeads: vi.fn().mockReturnValue(of({ leads: LEADS, nextCursor: null, totalCount: 2 })) };
    ref = { close: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [AdminCreateInvoiceComponent],
      providers: [
        provideStore([BillingHealthState, AdminBuildersState]),
        { provide: AdminBillingApiService, useValue: billingApi },
        { provide: AdminBuildersApiService, useValue: { listBuilders: vi.fn(() => of({ builders: BUILDERS })) } },
        { provide: AdminLeadsApiService, useValue: leadsApi },
        { provide: ConfigService, useValue: { get: () => ({ debounceMs: 0 }) } },
        { provide: DialogRef, useValue: ref },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminCreateInvoiceComponent);
    component = fixture.componentInstance;
    el = fixture.nativeElement as HTMLElement;
    fixture.autoDetectChanges();
    await fixture.whenStable();
  });

  function comboboxes(): HTMLInputElement[] {
    return Array.from(el.querySelectorAll<HTMLInputElement>('input[role="combobox"]'));
  }

  /** Types into a combobox and picks the first match with Enter. */
  async function pick(input: HTMLInputElement, text: string): Promise<void> {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await fixture.whenStable();
  }

  async function fillValidForm(builder = 'Custom Rate'): Promise<void> {
    await pick(comboboxes()[0], builder);
    await until(() => component.leadOptions().length > 0, 'leads loaded');
    await pick(comboboxes()[1], 'Priya');
    component.form.controls.contractValueCents.setValue(85_000_000);
    component.form.controls.signedDate.setValue('2026-09-20');
    await fixture.whenStable();
  }

  function q(id: string): HTMLElement | null {
    return el.querySelector(`[data-testid="${id}"]`);
  }

  it('uses EntityComboboxes for builder and lead — no UUID field (AC2)', () => {
    const boxes = comboboxes();
    expect(boxes.length).toBe(2);
    expect(el.textContent).not.toMatch(/UUID/i);
    // The lead picker waits for a builder.
    expect(boxes[1].disabled).toBe(true);
    expect(el.textContent).toContain('Choose a builder first.');
  });

  it('loads the builder’s leads when a builder is picked, scoped by builder id', async () => {
    await pick(comboboxes()[0], 'Custom Rate');
    expect(component.form.controls.builderId.value).toBe('b-2');
    await until(() => leadsApi.listLeads.mock.calls.length > 0, 'lead search');
    expect(leadsApi.listLeads).toHaveBeenCalledWith({ builderId: 'b-2' }, null, 20);
    expect(comboboxes()[1].disabled).toBe(false);
  });

  it('searches leads on the server as the admin types', async () => {
    await pick(comboboxes()[0], 'Test Builder');
    const lead = comboboxes()[1];
    lead.focus();
    lead.value = 'pri';
    lead.dispatchEvent(new Event('input'));
    await until(
      () => leadsApi.listLeads.mock.calls.some(([filters]) => filters.search === 'pri'),
      'typed search',
    );
    expect(leadsApi.listLeads).toHaveBeenLastCalledWith({ builderId: 'b-1', search: 'pri' }, null, 20);
  });

  it('resets the lead when the builder changes', async () => {
    await fillValidForm();
    expect(component.form.controls.leadId.value).toBe(LEAD_ID);
    await pick(comboboxes()[0], 'Test Builder');
    expect(component.form.controls.leadId.value).toBeNull();
  });

  it('blocks the review step while the form is invalid', async () => {
    expect((q('create-invoice-review-btn') as HTMLButtonElement).disabled).toBe(true);
    component.startReview();
    expect(component.reviewing()).toBe(false);
  });

  it('reviews with names (not ids) and the estimate at the builder’s rate', async () => {
    await fillValidForm();
    (q('create-invoice-review-btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    const review = q('create-invoice-review')?.textContent ?? '';
    expect(review).toContain('Custom Rate Builder');
    expect(review).toContain('Priya Shah');
    expect(review).not.toContain(LEAD_ID);
    expect(review).toContain('$850,000');
    expect(review).toContain('(2%)');
    expect(q('create-invoice-estimate')?.textContent).toContain('$17,000');
    expect(billingApi.createManualInvoice).not.toHaveBeenCalled();
  });

  it('dispatches the create with the tenant key, lead id, integer cents and an offset ISO datetime', async () => {
    await fillValidForm();
    component.startReview();
    await fixture.whenStable();
    (q('create-invoice-confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    const body = billingApi.createManualInvoice.mock.calls[0][0];
    expect(body.tenantKey).toBe('custom-rate-builder');
    expect(body.leadId).toBe(LEAD_ID);
    expect(body.contractValueCents).toBe(85_000_000);
    expect(body.contractSignedAt).toMatch(/^2026-09-20T12:00:00[+-]\d{2}:\d{2}$/);
  });

  it('shows the server figures on success and closes with true', async () => {
    await fillValidForm();
    component.startReview();
    await fixture.whenStable();
    (q('create-invoice-confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    const done = q('create-invoice-done')?.textContent ?? '';
    expect(done).toContain('In review');
    expect(done).toContain('$17,000');
    expect(done).toContain('Custom Rate Builder');
    (q('create-invoice-close') as HTMLButtonElement).click();
    expect(ref.close).toHaveBeenCalledWith(true);
  });

  it('keeps a friendly server error inline on the review step', async () => {
    billingApi.createManualInvoice.mockReturnValue(throwError(() => ({ status: 404, error: { code: 'NOT_FOUND' } })));
    await fillValidForm();
    component.startReview();
    await fixture.whenStable();
    (q('create-invoice-confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('not found');
    expect(ref.close).not.toHaveBeenCalled();
  });

  it('cancel closes with false', () => {
    component.close();
    expect(ref.close).toHaveBeenCalledWith(false);
  });

  it('builds picker options with human labels and meta', () => {
    expect(builderOption(BUILDERS[1])).toEqual({ id: 'b-2', label: 'Custom Rate Builder', meta: 'custom-rate-builder · 2%' });
    expect(leadOption(LEADS[0])).toEqual({ id: LEAD_ID, label: 'Priya Shah', meta: '123 Main St NW · Won' });
  });

  it('formats an ISO datetime with an explicit timezone offset', () => {
    const iso = toIsoWithOffset(new Date(2026, 8, 20, 12, 0, 0));
    expect(iso).toMatch(/^2026-09-20T12:00:00[+-]\d{2}:\d{2}$/);
  });
});
