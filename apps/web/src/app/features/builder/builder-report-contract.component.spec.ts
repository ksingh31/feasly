/**
 * Builder report-contract component tests.
 *
 * Verifies: the dollars→cents conversion (integer math, never float), the
 * ISO-datetime-with-offset composition, form validation (required fields,
 * invalid amounts, future dates), the submit posts converted cents + the
 * offset datetime, the success view shows the reported amount and the 1%
 * figure, and failures show the RFC 7807 server message.
 *
 * Note: async/await with real timers (not fakeAsync) — zone.js is not
 * installed in this repo, so the fakeAsync helper cannot run here.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type {
  BuilderLeadListResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { BuilderState } from './builder.state';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import { BuilderBillingApiService } from './builder-billing-api.service';
import {
  BuilderReportContractComponent,
  dateOnlyToIsoWithOffset,
  parseCadDollarsToCents,
} from './builder-report-contract.component';
import { BuilderReportContractState } from './builder-report-contract.state';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';

const LEADS_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      id: LEAD_ID,
      name: 'Jane Homeowner',
      email: 'jane@example.com',
      phone: '403-555-0101',
      timeline: '3–6 months',
      leadScore: 82,
      status: 'quoted',
      statusUpdatedAt: '2026-09-20T10:00:00.000Z',
      addressKey: '123 Main St SW',
      projectType: 'new-build',
      createdAt: '2026-09-19T10:00:00.000Z',
    },
  ],
  summary: { total: 1, new: 0, contacted: 0, quoted: 1, won: 0, lost: 0 },
};

async function setup(
  reportContractImpl: (
    body: unknown,
  ) => ReturnType<BuilderBillingApiService['reportContract']>,
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuilderReportContractComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderState, BuilderReportContractState]),
      {
        provide: ConfigService,
        useValue: {
          get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s],
        },
      },
      {
        provide: BuilderLeadsApiService,
        useValue: { listLeads: () => of(LEADS_RESPONSE) },
      },
      {
        provide: BuilderBillingApiService,
        useValue: { reportContract: vi.fn(reportContractImpl) },
      },
    ],
  });
  const fixture: ComponentFixture<BuilderReportContractComponent> =
    TestBed.createComponent(BuilderReportContractComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, store: TestBed.inject(Store) };
}

describe('parseCadDollarsToCents', () => {
  it('converts whole dollars to cents', () => {
    expect(parseCadDollarsToCents('650000')).toBe(65000000);
  });

  it('converts dollars-and-cents without float error', () => {
    // 650000.50 * 100 as a float is 65000049.99… — integer math stays exact.
    expect(parseCadDollarsToCents('650000.50')).toBe(65000050);
    expect(parseCadDollarsToCents('0.07')).toBe(7);
  });

  it('tolerates currency formatting characters', () => {
    expect(parseCadDollarsToCents('$650,000')).toBe(65000000);
  });

  it('rejects invalid amounts', () => {
    expect(parseCadDollarsToCents(null)).toBeNull();
    expect(parseCadDollarsToCents('')).toBeNull();
    expect(parseCadDollarsToCents('abc')).toBeNull();
    expect(parseCadDollarsToCents('650000.555')).toBeNull();
    expect(parseCadDollarsToCents('-100')).toBeNull();
  });
});

describe('dateOnlyToIsoWithOffset', () => {
  it('composes a full ISO datetime with an explicit offset', () => {
    const iso = dateOnlyToIsoWithOffset('2026-09-20');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00([+-]\d{2}:\d{2})$/);
    expect(iso.startsWith('2026-09-20T00:00:00')).toBe(true);
  });
});

describe('BuilderReportContractComponent', () => {
  it('rejects an empty form', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const component = fixture.componentInstance;
    expect(component.form.invalid).toBe(true);
    await component.submit();
    // No API call on an invalid form.
    const api = TestBed.inject(BuilderBillingApiService);
    expect(api.reportContract).not.toHaveBeenCalled();
  });

  it('rejects a future signing date', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const component = fixture.componentInstance;
    const now = new Date();
    const future = `${now.getFullYear() + 1}-01-15`;
    component.form.controls.leadId.setValue(LEAD_ID);
    component.form.controls.contractValue.setValue('650000');
    component.form.controls.contractSignedDate.setValue(future);
    expect(component.form.controls.contractSignedDate.invalid).toBe(true);
    expect(component.form.invalid).toBe(true);
  });

  it('rejects an invalid contract amount', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const component = fixture.componentInstance;
    component.form.controls.contractValue.setValue('not-a-number');
    expect(component.form.controls.contractValue.invalid).toBe(true);
  });

  it('posts converted cents + an offset datetime, then shows the 1% figure', async () => {
    const api = { calls: [] as unknown[] };
    const { fixture } = await setup((body) => {
      api.calls.push(body);
      return of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' });
    });
    const component = fixture.componentInstance;
    component.form.controls.leadId.setValue(LEAD_ID);
    component.form.controls.contractValue.setValue('650000');
    component.form.controls.contractSignedDate.setValue('2026-09-20');
    expect(component.form.valid).toBe(true);

    await component.submit();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.calls).toHaveLength(1);
    const body = api.calls[0] as {
      leadId: string;
      contractValueCents: number;
      contractSignedAt: string;
    };
    // The critical conversion: dollars → integer cents (never dollars).
    expect(body.contractValueCents).toBe(65000000);
    expect(body.leadId).toBe(LEAD_ID);
    expect(body.contractSignedAt).toMatch(
      /^2026-09-20T00:00:00([+-]\d{2}:\d{2})$/,
    );

    // Success view: reported amount + 1% of 65000000 cents = 650000 cents.
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('$650,000');
    expect(text).toContain('$6,500');
    expect(text).toContain('7-day review window');
  });

  it('shows the RFC 7807 server message on failure', async () => {
    const { fixture } = await setup(() =>
      throwError(() => ({
        code: 'VALIDATION_FAILED',
        message: 'Invalid contract report body.',
        retryable: false,
      })),
    );
    const component = fixture.componentInstance;
    component.form.controls.leadId.setValue(LEAD_ID);
    component.form.controls.contractValue.setValue('650000');
    component.form.controls.contractSignedDate.setValue('2026-09-20');

    await component.submit();
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invalid contract report body.');
  });

  it('shows flat-plan copy when the contract is covered', async () => {
    const { fixture } = await setup(() =>
      of({ billed: false, reason: 'flat_subscription_covers' }),
    );
    const component = fixture.componentInstance;
    component.form.controls.leadId.setValue(LEAD_ID);
    component.form.controls.contractValue.setValue('650000');
    component.form.controls.contractSignedDate.setValue('2026-09-20');

    await component.submit();
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('flat plan');
  });
});
