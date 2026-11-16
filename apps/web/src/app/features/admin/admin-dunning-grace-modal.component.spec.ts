/**
 * #901 "Edit grace days" modal: config-bounded whole-number input, Save
 * disabled until a valid different value is typed and while saving, posts
 * `set_grace_days`, closes with the saved value, keeps failures inline.
 */
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminDunningGraceModalComponent } from './admin-dunning-grace-modal.component';
import { DEFAULT_ADMIN_COPY } from './admin-copy.defaults';
import { BillingHealthState } from './billing-health.state';

const D = DEFAULT_ADMIN_COPY.dunning;
const OK = { invoiceId: 'inv-1', status: 'failed', dunningState: 'active', retryGraceDays: 14, nextRetryAt: null };

async function setup(reply: () => Observable<unknown> = () => of(OK)) {
  const api = { getBillingHealth: vi.fn(() => of(null)), updateInvoiceDunning: vi.fn(reply) };
  const ref = { close: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideStore([BillingHealthState]),
      { provide: AdminBillingApiService, useValue: api },
      { provide: DialogRef, useValue: ref },
      {
        provide: DIALOG_DATA,
        useValue: { invoiceId: 'inv-1', builderName: 'Elite Craft Builders', commissionCents: 15_000, graceDays: 7 },
      },
    ],
  });
  const fixture = TestBed.createComponent(AdminDunningGraceModalComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const input = () => el.querySelector('input') as HTMLInputElement;
  const submitBtn = () => el.querySelector('[data-testid="grace-days-submit"]') as HTMLButtonElement;
  const type = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  return { fixture, el, api, ref, input, submitBtn, type };
}

describe('AdminDunningGraceModalComponent (#901)', () => {
  it('names the builder and amount and starts from the current grace days', async () => {
    const { el, input, submitBtn } = await setup();
    expect(el.textContent).toContain('Elite Craft Builders · $150');
    expect(input().value).toBe('7');
    expect(el.textContent).toContain('1 to 90');
    // Unchanged value: nothing to save.
    expect(submitBtn().disabled).toBe(true);
  });

  it('rejects values outside the configured bounds or not whole', async () => {
    const { el, submitBtn, type } = await setup();
    for (const bad of ['0', '91', '2.5', 'abc']) {
      await type(bad);
      expect(submitBtn().disabled).toBe(true);
      expect(el.textContent).toContain('Enter a whole number from 1 to 90.');
    }
  });

  it('posts set_grace_days and closes with the saved value', async () => {
    const { api, ref, submitBtn, type } = await setup();
    await type('14');
    expect(submitBtn().disabled).toBe(false);
    submitBtn().click();
    expect(api.updateInvoiceDunning).toHaveBeenCalledWith('inv-1', { action: 'set_grace_days', graceDays: 14 });
    expect(ref.close).toHaveBeenCalledWith(14);
  });

  it('stays disabled while saving (one request on a double click)', async () => {
    const reply = new Subject<unknown>();
    const { api, fixture, submitBtn, type } = await setup(() => reply.asObservable());
    await type('14');
    submitBtn().click();
    submitBtn().click();
    await fixture.whenStable();
    expect(api.updateInvoiceDunning).toHaveBeenCalledTimes(1);
    expect(submitBtn().disabled).toBe(true);
    reply.next(OK);
    reply.complete();
  });

  it('keeps a refused save inline and does not close', async () => {
    const { el, ref, fixture, submitBtn, type } = await setup(() =>
      throwError(() => ({ code: 'CONFLICT', message: 'x', retryable: false })),
    );
    await type('14');
    submitBtn().click();
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="grace-days-error"]')?.textContent?.trim()).toBe(D.conflictError);
    expect(ref.close).not.toHaveBeenCalled();
    expect(submitBtn().disabled).toBe(false);
  });
});
