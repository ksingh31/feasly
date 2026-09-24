import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import type { PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { LeadState, SelectProperty, StoreLeadResult, UpdateInputs, WizardState } from '../wizard';
import { SetReportToken, UnlockReport } from './report.actions';
import { ReportState } from './report.state';
import { ReportPageComponent, withLandRowFirst } from './report-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

describe('withLandRowFirst', () => {
  const landRange = { low: 395000, base: 420000, high: 445000 };
  const rows = [{ key: 'site', label: 'Site', range: { low: 1, base: 2, high: 3 } }];

  it('synthesizes the land row first when the API sent none', () => {
    const out = withLandRowFirst(rows, landRange, 'Land (assessed value)');
    expect(out[0]).toEqual({ key: 'land', label: 'Land (assessed value)', range: landRange });
    expect(out.length).toBe(2);
  });

  it('keeps the API land row as-is (no duplicates)', () => {
    const withLand = [{ key: 'land', label: 'Land (assessed value)', range: landRange }, ...rows];
    expect(withLandRowFirst(withLand, landRange, 'Land (assessed value)')).toEqual(withLand);
  });
});

/**
 * M1: the report page renders blurred placeholders pre-gate (with the single
 * "Unlock" CTA toward the gate) and real ranges post-gate; tier what-if and
 * sqft re-run go through the API; no $/sqft and no margin figures anywhere.
 */
describe('ReportPageComponent', () => {
  let fixture: ComponentFixture<ReportPageComponent>;
  let store: Store;
  let api: MockApiService;

  const fakeProperty = {
    addressKey: 'calgary-918-16-ave-nw',
    address: '918 16 Ave NW, Calgary, AB',
    community: 'Mount Pleasant',
    lotSqft: 6100,
    zoning: 'R-C1',
    assessedValue: 823000,
    assessmentYear: 2025,
    yearBuilt: 1974,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  const baseConfig = {
    api: { useMockApi: true },
    timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
    wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
  };

  const text = (): string => fixture.nativeElement.textContent ?? '';

  async function pollFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 8000;
    for (;;) {
      fixture.detectChanges();
      if (predicate()) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ReportPageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/report', component: ReportPageComponent },
          { path: 'estimate/gate', component: BlankComponent },
        ]),
        provideStore([WizardState, ReportState, LeadState]),
        providePropertyData(),
        { provide: API_SERVICE, useClass: MockApiService },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    store = TestBed.inject(Store);
    api = TestBed.inject(API_SERVICE) as MockApiService;
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
    fixture = TestBed.createComponent(ReportPageComponent);
    fixture.detectChanges();
    await pollFor(() => store.selectSnapshot(ReportState.status) === 'ready', 'preview load');
  }

  /** Drives the mock lead flow and unlocks the report on the live fixture. */
  async function unlock(): Promise<void> {
    const preview = await firstValueFrom(
      api.getPreviewEstimate({
        addressKey: fakeProperty.addressKey,
        sqft: 2200,
        tier: 'premium',
        garage: 'double',
        basement: 'unfinished',
      }),
    );
    const lead = await firstValueFrom(
      api.submitLead({
        email: 'buyer@example.com',
        name: 'Test Buyer',
        timeline: '6-12mo',
        marketingConsent: false,
        estimateId: preview.estimateId,
      }),
    );
    const token = api.devTokenForLead(lead.leadId);
    expect(token).toBeTruthy();
    store.dispatch([new SetReportToken(token!), new UnlockReport()]);
    await pollFor(() => store.selectSnapshot(ReportState.unlocked), 'unlock');
  }

  function tierButton(name: string): HTMLButtonElement {
    const buttons = [...fixture.nativeElement.querySelectorAll('.tier-btn')];
    const found = buttons.find((b: Element) => b.textContent?.trim() === name);
    expect(found).toBeTruthy();
    return found as HTMLButtonElement;
  }

  beforeEach(async () => {
    await setup();
  });

  describe('pre-gate', () => {
    it('renders blurred placeholders and the Unlock CTA toward the gate', () => {
      expect(fixture.nativeElement.querySelectorAll('.blur-value').length).toBeGreaterThan(0);
      expect(fixture.nativeElement.querySelectorAll('.range-value').length).toBe(0);
      const unlock = fixture.nativeElement.querySelector('a.unlock') as HTMLAnchorElement;
      expect(unlock?.textContent).toContain('Unlock');
      expect(unlock?.getAttribute('href')).toBe('/estimate/gate');
    });

    it('shows no real dollar figures pre-gate', () => {
      // The blur guarantee: every real figure is >= 100000, so no run of 6+
      // digits may appear anywhere (the "2,200 sq ft" stepper is 4 digits).
      expect(text()).not.toMatch(/\d{6}/);
    });

    it('locks the tier what-if and sqft adjuster behind the gate', () => {
      for (const btn of fixture.nativeElement.querySelectorAll('.tier-btn')) {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      }
      const rerun = [...fixture.nativeElement.querySelectorAll('button')].find((b: Element) =>
        b.textContent?.includes('Re-run'),
      ) as HTMLButtonElement;
      expect(rerun?.disabled).toBe(true);
      expect(text()).toContain('Unlock your report to explore finish tiers.');
    });

    it('reserves "Unlock" for the preview-to-gate CTA', () => {
      const matches = [...fixture.nativeElement.querySelectorAll('a, button')].filter((el: Element) =>
        el.textContent?.includes('Unlock'),
      );
      expect(matches.length).toBe(1);
      expect((matches[0] as HTMLAnchorElement).getAttribute('href')).toBe('/estimate/gate');
    });

    it('report copy carries no ±, %, or accuracy claim (copy-lint)', () => {
      const config = TestBed.inject(ConfigService);
      const dump = JSON.stringify(config.get('copy').report);
      expect(dump).not.toMatch(/[±%]/);
      expect(dump.toLowerCase()).not.toContain('accura');
    });

    it('shows the pending "check your email" state (no unlock CTA) when a lead was submitted but the report is still locked', () => {
      // Real-backend shape: lead submitted, magic link on its way, no token.
      store.dispatch(
        new StoreLeadResult({
          leadId: 'lead-pending-1',
          email: 'buyer@example.com',
          magicLinkSent: true,
          expiresInDays: 7,
        }),
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('a.unlock')).toBeNull();
      const pending = fixture.nativeElement.querySelector('.pending-note');
      expect(pending).not.toBeNull();
      expect(pending.textContent).toContain('magic link');
      // Still blurred — no figures leak while locked.
      expect(text()).not.toMatch(/\d{6}/);
    });
  });

  describe('post-gate', () => {
    beforeEach(async () => {
      await unlock();
    });

    it('renders low/base/high hero ranges from the deterministic base (not a client midpoint)', () => {
      const values = [...fixture.nativeElement.querySelectorAll('.hero-total .range-value')].map(
        (el: Element) => el.textContent?.trim(),
      );
      expect(values.length).toBe(3);
      for (const v of values) {
        expect(v).toMatch(/^\$\d{1,3}(,\d{3})*$/);
      }
      // Mock total base is the contract's deterministic base, not (low+high)/2.
      expect(values[1]).toBe('$1,091,500');
      const labels = [...fixture.nativeElement.querySelectorAll('.hero-total .range-label')].map((el: Element) =>
        el.textContent?.trim(),
      );
      expect(labels).toEqual(['Low', 'Base', 'High']);
    });

    it('renders the itemized breakdown: land, hard costs, soft costs, contingency', () => {
      const labels = [...fixture.nativeElement.querySelectorAll('.row-label')].map((el: Element) =>
        el.textContent?.trim(),
      );
      expect(labels[0]).toBe('Land (assessed value)');
      expect(labels).toContain('Soft costs (permits, design, fees)');
      expect(labels).toContain('Contingency');
      expect(labels.length).toBeGreaterThanOrEqual(9);
    });

    it('never shows $/sqft or margin percentages', () => {
      expect(text()).not.toMatch(/\/\s*sq\.?\s*ft/i);
      expect(text()).not.toMatch(/per\s+sq/i);
      expect(text()).not.toMatch(/%/);
    });

    it('tier what-if re-runs the estimate through the API', async () => {
      const before = store.selectSnapshot(ReportState.snapshot)!;
      tierButton('Luxury').click();
      await pollFor(
        () => store.selectSnapshot(ReportState.snapshot)?.inputs.tier === 'luxury',
        'luxury revision',
      );
      const after = store.selectSnapshot(ReportState.snapshot)!;
      expect(after.totalRange.low).toBeGreaterThan(before.totalRange.low);
      expect(after.version).toBe(before.version + 1);
      expect(tierButton('Luxury').classList.contains('selected')).toBe(true);
    });

    it('sqft stepper re-runs the estimate with the new size', async () => {
      const plus = [...fixture.nativeElement.querySelectorAll('.step-btn')].find((b: Element) =>
        b.textContent?.includes('+'),
      ) as HTMLButtonElement;
      plus.click();
      fixture.detectChanges();
      expect(text()).toContain('2,250 sq ft');
      const rerun = [...fixture.nativeElement.querySelectorAll('button')].find((b: Element) =>
        b.textContent?.includes('Re-run'),
      ) as HTMLButtonElement;
      rerun.click();
      await pollFor(
        () => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2250,
        'sqft revision',
      );
      expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(2);
    });

    it('shows the AI narrative placeholder with the deterministic disclaimer, never mock narrative', () => {
      expect(text()).toContain('coming soon');
      expect(text()).toContain(
        'Dollar figures are calculated deterministically from our cost model — not generated by AI.',
      );
      expect(text()).not.toContain('infill home on this lot');
    });

    it('renders the next-3-steps checklist', () => {
      const steps = fixture.nativeElement.querySelectorAll('.steps li');
      expect(steps.length).toBe(3);
    });

    it('partner share validates email and sends', async () => {
      const email = fixture.nativeElement.querySelector('input[type="email"]') as HTMLInputElement;
      const send = [...fixture.nativeElement.querySelectorAll('button')].find((b: Element) =>
        b.textContent?.trim() === 'Send report',
      ) as HTMLButtonElement;
      send.click();
      fixture.detectChanges();
      await pollFor(() => text().includes('Enter a valid email address'), 'share validation');
      email.value = 'partner@example.com';
      email.dispatchEvent(new Event('input'));
      send.click();
      await pollFor(() => text().includes('their own secure link'), 'share sent');
    });

    it('callback request validates and sends', async () => {
      const request = [...fixture.nativeElement.querySelectorAll('button')].find((b: Element) =>
        b.textContent?.trim() === 'Request callback',
      ) as HTMLButtonElement;
      request.click();
      fixture.detectChanges();
      await pollFor(() => text().includes('Enter your name and a phone number'), 'callback validation');
      const name = fixture.nativeElement.querySelector('input[formControlName="name"]') as HTMLInputElement;
      const phone = fixture.nativeElement.querySelector('input[formControlName="phone"]') as HTMLInputElement;
      name.value = 'Test Buyer';
      name.dispatchEvent(new Event('input'));
      phone.value = '4035551234';
      phone.dispatchEvent(new Event('input'));
      request.click();
      await pollFor(() => text().includes('Callback requested'), 'callback sent');
    });
  });
});
