import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AdminBillingApiService } from './admin-billing-api.service';
import { BillingHealthState } from './billing-health.state';
import {
  AdminManageInvoiceComponent,
  type ManageInvoiceInput,
} from './admin-manage-invoice.component';

const INVOICE: ManageInvoiceInput = {
  id: 'inv-2',
  tenantKey: 'test-builder',
  commissionCents: 500_000,
  currency: 'CAD',
  commissionRatePercent: 1,
  contractValueCents: 50_000_000,
  reviewDueAt: '2026-10-03T12:00:00.000Z',
  status: 'in_review',
};

/** Local `yyyy-MM-dd` for "today", mirroring the component's default. */
function localToday(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function setInput(
  fixture: ComponentFixture<AdminManageInvoiceComponent>,
  selector: string,
  value: string,
): void {
  const input = fixture.nativeElement.querySelector(
    selector,
  ) as HTMLInputElement;
  expect(input, `input ${selector}`).not.toBeNull();
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function clickButton(
  fixture: ComponentFixture<AdminManageInvoiceComponent>,
  label: string,
): void {
  const button = Array.from(
    fixture.nativeElement.querySelectorAll('button'),
  ).find((b) =>
    (b as HTMLButtonElement).textContent?.trim().startsWith(label),
  ) as HTMLButtonElement;
  expect(button, `button "${label}"`).toBeDefined();
  button.click();
  fixture.detectChanges();
}

describe('AdminManageInvoiceComponent', () => {
  let fixture: ComponentFixture<AdminManageInvoiceComponent>;
  let api: {
    markInvoicePaid: ReturnType<typeof vi.fn>;
    setCommissionRate: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      markInvoicePaid: vi.fn().mockReturnValue(
        of({
          invoiceId: 'inv-2',
          status: 'paid',
          paidAt: '2026-09-29T18:00:00.000Z',
          paymentMethod: 'cheque',
          reference: 'CHQ-1234',
        }),
      ),
      setCommissionRate: vi.fn().mockReturnValue(
        of({
          invoiceId: 'inv-2',
          status: 'in_review',
          commissionRatePercent: 1.5,
          contractValueCents: 50_000_000,
          commissionCents: 750_000,
          currency: 'CAD',
        }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [AdminManageInvoiceComponent],
      providers: [
        provideStore([BillingHealthState]),
        { provide: AdminBillingApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminManageInvoiceComponent);
    fixture.componentRef.setInput('invoice', INVOICE);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the invoice summary with the current effective rate', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Manage invoice');
    expect(text).toContain('test-builder');
    expect(text).toContain('In review');
    expect(text).toContain('1%');
    expect(text).toContain('$500,000');
  });

  it('defaults the paid date to today', () => {
    const input = fixture.nativeElement.querySelector(
      '#manage-paid-date',
    ) as HTMLInputElement;
    expect(input.value).toBe(localToday());
  });

  it('shows a live recalculated preview when a rate is entered', () => {
    setInput(fixture, '#manage-rate', '1.5');
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    // 1.5% of the $500,000 contract (excluding land).
    expect(text).toContain('$7,500');
    expect(text).toContain('1.5%');
  });

  it('requires a confirm click before dispatching the rate update', async () => {
    setInput(fixture, '#manage-rate', '1.5');
    fixture.detectChanges();
    clickButton(fixture, 'Update rate');
    // First click only arms the confirm — no API call yet.
    expect(api.setCommissionRate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Confirm update rate');
    clickButton(fixture, 'Confirm update rate');
    await fixture.whenStable();
    expect(api.setCommissionRate).toHaveBeenCalledWith('inv-2', 1.5);
  });

  it('does not arm the rate confirm for an invalid rate', () => {
    setInput(fixture, '#manage-rate', '0');
    fixture.detectChanges();
    clickButton(fixture, 'Update rate');
    expect(api.setCommissionRate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).not.toContain(
      'Confirm update rate',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Enter a rate over 0% and at most 10%.',
    );
  });

  it('requires a confirm click before dispatching mark-paid with the body shape', async () => {
    const method = fixture.nativeElement.querySelector(
      '#manage-method',
    ) as HTMLSelectElement;
    method.value = 'cheque';
    method.dispatchEvent(new Event('change'));
    setInput(fixture, '#manage-reference', 'CHQ-1234');
    setInput(fixture, '#manage-paid-date', '2026-09-29');
    fixture.detectChanges();
    clickButton(fixture, 'Mark as paid');
    // First click only arms the confirm — no API call yet.
    expect(api.markInvoicePaid).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Confirm mark paid');
    clickButton(fixture, 'Confirm mark paid');
    await fixture.whenStable();
    expect(api.markInvoicePaid).toHaveBeenCalledTimes(1);
    const [invoiceId, body] = api.markInvoicePaid.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(invoiceId).toBe('inv-2');
    expect(body['paymentMethod']).toBe('cheque');
    expect(body['reference']).toBe('CHQ-1234');
    // ISO 8601 with an explicit timezone offset for the paid date.
    expect(body['paidAt']).toMatch(/^2026-09-29T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it('omits the reference when left blank', async () => {
    const method = fixture.nativeElement.querySelector(
      '#manage-method',
    ) as HTMLSelectElement;
    method.value = 'cash';
    method.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    clickButton(fixture, 'Mark as paid');
    clickButton(fixture, 'Confirm mark paid');
    await fixture.whenStable();
    const [, body] = api.markInvoicePaid.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body['paymentMethod']).toBe('cash');
    expect('reference' in body).toBe(false);
  });

  it('shows an error when the rate update fails', async () => {
    api.setCommissionRate.mockReturnValue(
      throwError(() => ({ status: 409, error: { code: 'CONFLICT' } })),
    );
    setInput(fixture, '#manage-rate', '2');
    fixture.detectChanges();
    clickButton(fixture, 'Update rate');
    clickButton(fixture, 'Confirm update rate');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'That invoice changed state',
    );
  });

  it('shows the server-confirmed result and closes on Done', async () => {
    setInput(fixture, '#manage-rate', '1.5');
    fixture.detectChanges();
    clickButton(fixture, 'Update rate');
    clickButton(fixture, 'Confirm update rate');
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Commission rate updated.');
    expect(text).toContain('$7,500');
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => {
      closed = true;
    });
    clickButton(fixture, 'Done');
    expect(closed).toBe(true);
  });

  it('emits closed when the Close button is clicked', () => {
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => {
      closed = true;
    });
    clickButton(fixture, 'Close');
    expect(closed).toBe(true);
  });
});
