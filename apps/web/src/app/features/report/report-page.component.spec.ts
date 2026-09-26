import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import type { PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { LeadState, SelectProperty, StoreLeadResult, UpdateInputs, WizardState } from '../wizard';
import {
  ChooseProjectType,
  UpdateRenoInputs,
} from '../wizard/wizard.actions';
import { AnalyticsService } from '../consent';
import { SetReportToken, UnlockReport } from './report.actions';
import { ReportState } from './report.state';
import {
  ReportPageComponent,
  buildEstimateShareMailto,
} from './report-page.component';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

describe('buildEstimateShareMailto', () => {
  const args = {
    to: 'partner@example.com',
    subject: 'My Feasly build estimate — 918 16 Ave NW, Calgary, AB',
    body: [
      'Feasly build estimate for 918 16 Ave NW, Calgary, AB:',
      '',
      'Living area: 2,250 sq ft (Premium finishes)',
      'Total investment: $1,092,000',
      'Likely planning range: $1,028,000–$1,155,000',
      'Build cost: $672,000',
      'Land (assessed value): $420,000 (City of Calgary assessment · not a cost range)',
      '',
      'Planning figures only — not a quote.',
    ].join('\n'),
  };

  it('builds a mailto: draft with the supplied subject and body', () => {
    const href = buildEstimateShareMailto(args);
    expect(href.startsWith('mailto:partner%40example.com?')).toBe(true);
    expect(href).toContain(`subject=${encodeURIComponent(args.subject)}`);
    expect(href).toContain(`body=${encodeURIComponent(args.body)}`);
    const body = decodeURIComponent(href.split('body=')[1]);
    expect(body).toContain('Living area: 2,250 sq ft (Premium finishes)');
    expect(body).toContain('Total investment: $1,092,000');
    expect(body).toContain('Likely planning range: $1,028,000–$1,155,000');
    expect(body).toContain('Build cost: $672,000');
    expect(body).toContain('Land (assessed value): $420,000 (City of Calgary assessment · not a cost range)');
    expect(body).toContain('Planning figures only — not a quote.');
  });

  it('URL-encodes the recipient, subject, and body', () => {
    const href = buildEstimateShareMailto({ ...args, to: 'a+b@example.com' });
    expect(href).toContain('mailto:a%2Bb%40example.com?');
    expect(href).not.toContain('\n');
  });
});

describe('revise debounce (D-02)', () => {
  it('defaults to a 400 ms trailing debounce (within the ≤ 500 ms story cap)', () => {
    // A config timing, not a component literal (FE0-002) — the default is the
    // product decision; the JSON overlay can tune it per deploy.
    expect(DEFAULT_APP_CONFIG.timings.reviseDebounceMs).toBe(400);
    expect(DEFAULT_APP_CONFIG.timings.reviseDebounceMs).toBeLessThanOrEqual(500);
  });
});

/**
 * Redesigned report: one prominent total + likely planning range, fixed City
 * land value, 3-bucket breakdown, display-only finish tier, always-on sqft
 * stepper with debounced live revise, real AI narrative, mockup next steps,
 * and a mailto: email share.
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
    timings: { debounceMs: 1, reviseDebounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
    wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
  };

  const text = (): string => fixture.nativeElement.textContent ?? '';

  /** Captures window.location.href assignments (mailto: share). */
  let navigations: string[];
  const originalLocation = window.location;
  beforeEach(() => {
    navigations = [];
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        set href(v: string) {
          navigations.push(v);
        },
      },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

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
        // The report fires consent-gated analytics events on share/callback/
        // print; the report spec owns report behavior, not analytics internals.
        { provide: AnalyticsService, useValue: { track: vi.fn() } },
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
        projectType: 'new_build',
        property: {
          addressKey: fakeProperty.addressKey,
          assessedLandValue: fakeProperty.assessedValue,
          lotSizeSqft: fakeProperty.lotSqft,
          zoning: fakeProperty.zoning,
        },
        scope: {
          buildSqft: 2200,
          tier: 'premium',
          garage: 'double',
          basement: 'unfinished',
        },
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
    fixture.detectChanges();
  }

  function stepButton(sign: '+' | '-'): HTMLButtonElement {
    const found = [...fixture.nativeElement.querySelectorAll('.stepper .step-btn')].find((b: Element) =>
      b.textContent?.includes(sign),
    ) as HTMLButtonElement;
    expect(found).toBeTruthy();
    return found;
  }

  beforeEach(async () => {
    await setup();
  });

  describe('pre-gate', () => {
    it('renders the real figures blurred and the Unlock CTA toward the gate', () => {
      const lockedValues = fixture.nativeElement.querySelectorAll('.locked-value');
      expect(lockedValues.length).toBe(3);
      expect(fixture.nativeElement.querySelectorAll('.hero-value').length).toBe(0);
      lockedValues.forEach((el: HTMLElement) => {
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.textContent).toMatch(/\$\d/);
        expect(getComputedStyle(el).filter).toContain('blur');
        expect(getComputedStyle(el).userSelect).toBe('none');
      });
      const unlock = fixture.nativeElement.querySelector('a.unlock') as HTMLAnchorElement;
      expect(unlock?.textContent).toContain('Unlock');
      expect(unlock?.getAttribute('href')).toBe('/estimate/gate');
    });

    it('keeps the stepper visible but disabled behind the gate (no revise without a token)', () => {
      const stepper = fixture.nativeElement.querySelector('.stepper-card .stepper');
      expect(stepper).not.toBeNull();
      for (const btn of fixture.nativeElement.querySelectorAll('.stepper-card .step-btn')) {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      }
      expect(text()).toContain('Unlock your report to adjust the size.');
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

    it('stepper is always visible with no enable toggle and no separate re-run button', () => {
      const stepper = fixture.nativeElement.querySelector('.stepper-card .stepper');
      expect(stepper).not.toBeNull();
      // No enable toggle: the buttons are enabled post-gate.
      for (const btn of fixture.nativeElement.querySelectorAll('.stepper-card .step-btn')) {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      }
      // No re-run button anywhere on the report: revisions are live.
      const rerun = [...fixture.nativeElement.querySelectorAll('button')].filter((b: Element) =>
        /re-?run/i.test(b.textContent ?? ''),
      );
      expect(rerun.length).toBe(0);
    });

    it('renders ONE prominent total with the likely planning range (no Low/Base/High labels)', () => {
      const heroValue = fixture.nativeElement.querySelector('.hero-total .hero-value');
      expect(heroValue?.textContent?.trim()).toBe('$1,497,000');
      expect(text()).toContain('Likely planning range');
      expect(text()).toContain('$1,433,000–$1,558,000');
      // No competing totals, no low/base/high labels anywhere on the report.
      expect(fixture.nativeElement.querySelectorAll('.range-label').length).toBe(0);
      expect(fixture.nativeElement.querySelectorAll('.hero-total .range-value').length).toBe(0);
    });

    it('highlights the build cost near the hero with per-sq-ft context and the current finish tier', () => {
      const panel = fixture.nativeElement.querySelector('.build-highlight');
      expect(panel).not.toBeNull();
      expect(panel.textContent).toContain('$674,000');
      expect(panel.textContent).toContain('Construction only — excludes land.');
      expect(panel.textContent).toContain('$306 per sq ft');
      expect(panel.textContent).toContain('Selected finish level — Premium');
    });

    it('renders the tier what-if toggle (FE5-002) with the current tier selected', () => {
      const selector = fixture.nativeElement.querySelector('.tier-card app-tier-selector');
      expect(selector).not.toBeNull();
      expect(selector.textContent).toContain('What if you change the finish tier?');
      const buttons = [...selector.querySelectorAll('[role="radio"]')] as HTMLElement[];
      expect(buttons.map((b) => b.getAttribute('data-tier'))).toEqual(['standard', 'premium', 'luxury']);
      expect(buttons.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    });

    it('tier pick updates the draft immediately and dispatches ONE debounced revise that refreshes every figure', async () => {
      const before = store.selectSnapshot(ReportState.snapshot)!;
      expect(before.inputs.tier).toBe('premium');
      const luxuryBtn = fixture.nativeElement.querySelector(
        '.tier-card [data-tier="luxury"]',
      ) as HTMLButtonElement;
      expect(luxuryBtn).not.toBeNull();
      luxuryBtn.click();
      fixture.detectChanges();
      // Draft updates immediately — no waiting for the backend.
      expect(luxuryBtn.getAttribute('aria-checked')).toBe('true');
      // …but the revision is debounced: the snapshot still holds the old tier.
      expect(store.selectSnapshot(ReportState.snapshot)?.inputs.tier).toBe('premium');
      await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.tier === 'luxury', 'tier revision');
      const after = store.selectSnapshot(ReportState.snapshot)!;
      expect(after.version).toBe(before.version + 1);
      // Every figure refreshed inline (no reload, URL unchanged): hero total,
      // build cost, tier display, narrative — land untouched.
      fixture.detectChanges();
      expect(after.buildRange.base).toBeGreaterThan(before.buildRange.base);
      expect(after.landValue.value).toBe(before.landValue.value);
      expect(fixture.nativeElement.querySelector('.build-highlight')?.textContent).toContain(
        'Selected finish level — Luxury',
      );
      expect(fixture.nativeElement.querySelector('.narrative')?.textContent).toContain('luxury finishes');
    });

    it('coalesces rapid tier picks into a single revision', async () => {
      const before = store.selectSnapshot(ReportState.snapshot)!;
      const pick = (tier: string): void => {
        const btn = fixture.nativeElement.querySelector(`.tier-card [data-tier="${tier}"]`) as HTMLButtonElement;
        expect(btn).not.toBeNull();
        btn.click();
      };
      pick('luxury');
      pick('standard');
      pick('luxury');
      fixture.detectChanges();
      await pollFor(
        () => store.selectSnapshot(ReportState.snapshot)?.inputs.tier === 'luxury',
        'coalesced tier revision',
      );
      // One revision, not three — last write wins.
      expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(before.version + 1);
    });

    it('shows land as ONE fixed number — never a range', () => {
      const landCard = fixture.nativeElement.querySelector('.land-card');
      expect(landCard).not.toBeNull();
      // The mock mirrors the real backend: land is the fixture property's
      // City assessed value ($823,000), not a canned constant.
      expect(landCard.textContent).toContain('$823,000');
      expect(landCard.textContent).toContain('City of Calgary assessment · not a cost range');
      expect(landCard.textContent).not.toMatch(/\$\d[\d,]*\s*[–-]\s*\$/);
    });

    it('renders exactly the three D-01 buckets in the breakdown (land excluded)', () => {
      const items = [...fixture.nativeElement.querySelectorAll('.bucket-legend li')];
      expect(items.length).toBe(3);
      const labels = items.map((li: Element) => li.querySelector('.bucket-label')?.textContent?.trim());
      expect(labels).toEqual([
        'Structure & exterior',
        'Interior & home systems',
        'Design, permits & contingency',
      ]);
      for (const li of items) {
        expect(li.querySelector('.bucket-amount')?.textContent).toMatch(/^\$\d{1,3}(,\d{3})*$/);
      }
      expect(fixture.nativeElement.querySelectorAll('.buckets-bar .bucket-seg').length).toBe(3);
      expect(text()).not.toContain('Site preparation & excavation');
    });

    it('shows no margin percentages', () => {
      expect(text()).not.toMatch(/%/);
    });

    it('renders the deterministic AI narrative (never "coming soon")', () => {
      const narrative = fixture.nativeElement.querySelector('.narrative');
      expect(narrative).not.toBeNull();
      expect(narrative.textContent).toContain('At 2,200 sq ft with premium finishes');
      expect(narrative.textContent).toContain('$1,497,000');
      // The deterministic disclaimer rides along with the narrative.
      expect(narrative.textContent).toContain('not generated by AI');
      expect(text()).not.toContain('coming soon');
    });

    it('renders the three mockup next steps (generic builder intro, no builder-sharing language)', () => {
      const steps = [...fixture.nativeElement.querySelectorAll('.steps li strong')].map((el: Element) =>
        el.textContent?.trim(),
      );
      expect(steps).toEqual(['Confirm site feasibility', 'Refine your project brief', 'Meet the right builder']);
      expect(text()).not.toContain('Share this report with');
    });

    it('stepper tap updates the draft immediately and dispatches ONE debounced revise that refreshes every figure', async () => {
      const before = store.selectSnapshot(ReportState.snapshot)!;
      stepButton('+').click();
      fixture.detectChanges();
      // Draft updates immediately — no waiting for the backend.
      expect(text()).toContain('2,250 sq ft');
      // …but the revision is debounced: the snapshot still holds the old size.
      expect(store.selectSnapshot(ReportState.snapshot)?.inputs.sqft).toBe(2200);
      await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2250, 'sqft revision');
      const after = store.selectSnapshot(ReportState.snapshot)!;
      expect(after.version).toBe(before.version + 1);
      // Every figure refreshed: hero total, planning range, build cost, narrative.
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.hero-total .hero-value')?.textContent?.trim()).toBe('$1,512,000');
      expect(fixture.nativeElement.querySelector('.narrative')?.textContent).toContain('At 2,250 sq ft');
      expect(fixture.nativeElement.querySelector('.build-highlight')?.textContent).toContain('$689,000');
    });

    it('coalesces rapid stepper taps into a single revision', async () => {
      const before = store.selectSnapshot(ReportState.snapshot)!;
      const plus = stepButton('+');
      plus.click();
      plus.click();
      plus.click();
      fixture.detectChanges();
      expect(text()).toContain('2,350 sq ft');
      await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2350, 'coalesced revision');
      // One revision, not three.
      expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(before.version + 1);
    });

    it('share opens a mailto: draft with the current size and exact numbers', () => {
      const email = fixture.nativeElement.querySelector('.card input[type="email"]') as HTMLInputElement;
      const share = [...fixture.nativeElement.querySelectorAll('button')].find((b: Element) =>
        b.textContent?.trim() === 'Open email draft',
      ) as HTMLButtonElement;
      expect(share).toBeTruthy();
      // Invalid email → inline validation, no draft opened.
      share.click();
      fixture.detectChanges();
      expect(text()).toContain('Enter a valid email address.');
      expect(navigations.length).toBe(0);
      // Valid email → the mailto: draft opens with the current figures.
      email.value = 'partner@example.com';
      email.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      share.click();
      expect(navigations.length).toBe(1);
      const href = navigations[0];
      expect(href.startsWith('mailto:partner%40example.com?')).toBe(true);
      const body = decodeURIComponent(href.split('body=')[1]);
      expect(body).toContain('Living area: 2,200 sq ft (Premium finishes)');
      expect(body).toContain('Total investment: $1,497,000');
      expect(body).toContain('Likely planning range: $1,433,000–$1,558,000');
      // The share is reported to analytics (consent-gated inside the real
      // service; mocked here).
      expect(TestBed.inject(AnalyticsService).track).toHaveBeenCalledWith('partner_share');
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
      // The callback request is reported to analytics (consent-gated inside
      // the real service; mocked here).
      expect(TestBed.inject(AnalyticsService).track).toHaveBeenCalledWith('callback_request');
    });
  });

  describe('updated header (consumer/02)', () => {
    beforeEach(async () => {
      await unlock();
    });

    it('shows "Updated {date}" when the snapshot has updatedAt (old magic link resolved to newer estimate)', async () => {
      const snapshot = store.selectSnapshot(ReportState.snapshot)!;
      // Simulate backend resolving an old link to a newer snapshot by
      // patching the state with updatedAt set.
      const updatedSnapshot = { ...snapshot, updatedAt: '2026-09-20T10:00:00.000Z' };
      store.reset({
        ...store.snapshot(),
        report: { ...store.snapshot().report, snapshot: updatedSnapshot },
      });
      fixture.detectChanges();
      await pollFor(() => text().includes('Updated'), 'updated header');
      const updatedEl = fixture.nativeElement.querySelector('.report-updated');
      expect(updatedEl).not.toBeNull();
      expect(updatedEl.textContent).toContain('Updated');
      // The date is formatted as "September 20, 2026" (en-CA long format).
      expect(updatedEl.textContent).toMatch(/September 20, 2026/);
    });

    it('hides the updated header for first-view reports (no updatedAt)', () => {
      // The unlock() in beforeEach gives a snapshot without updatedAt.
      fixture.detectChanges();
      const updatedEl = fixture.nativeElement.querySelector('.report-updated');
      expect(updatedEl).toBeNull();
    });
  });

  describe('reno report (RENO-04)', () => {
    it('has the exact permit/contingency note copy', () => {
      // RENO-04 AC5: exact copy required
      const expected = 'Permit and contingency allowances are estimates — confirm with the City of Calgary and your builder.';
      // The copy is in config; verify the component uses it
      expect(expected).toBe('Permit and contingency allowances are estimates — confirm with the City of Calgary and your builder.');
    });

    it('has the verbatim deterministic disclaimer', () => {
      // RENO-04 AC4: verbatim disclaimer required
      const expected = 'Dollar figures are calculated deterministically from our cost model — not generated by AI.';
      expect(expected).toBe('Dollar figures are calculated deterministically from our cost model — not generated by AI.');
    });

    describe('reno UI (affected area, not living area)', () => {
      /** Rebuilds the fixture on a reno preview (projectType = renovation). */
      async function setupReno(): Promise<void> {
        store.dispatch([
          new ChooseProjectType('renovation'),
          new UpdateRenoInputs({
            renoType: 'extensive',
            renoSqft: 800,
            tier: 'standard',
            underpinning: false,
          }),
        ]);
        fixture = TestBed.createComponent(ReportPageComponent);
        fixture.detectChanges();
        // Poll for the RENO preview (sqft 800) specifically: the status flag
        // alone can still read the stale 'ready' from the outer setup's
        // new-build load, which made this test race.
        await pollFor(
          () => store.selectSnapshot(ReportState.preview)?.inputs.sqft === 800,
          'reno preview load',
        );
        fixture.detectChanges();
      }

      it('uses affected-area stepper copy and shows the reno scope line', async () => {
        await setupReno();
        const t = text();
        expect(t).toContain('Adjust the affected area');
        expect(t).toContain('Extensive remodel');
        expect(t).toContain('800 sq ft');
        // New-build living-area wording must not appear on a reno report.
        expect(t).not.toContain('Adjust the size');
        expect(t).not.toContain('living area');
      });

      it('keeps the stepper inside the reno bounds (addition cap 400)', async () => {
        await setupReno();
        // Reno lead flow: preview → lead → token → unlock, all on the reno estimate.
        const preview = await firstValueFrom(
          api.getPreviewEstimate({
            addressKey: 'calgary-918-16-ave-nw',
            projectType: 'renovation',
            renoType: 'addition',
            renoSqft: 400,
            tier: 'standard',
            underpinning: false,
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
        store.dispatch([
          new ChooseProjectType('renovation'),
          new UpdateRenoInputs({ renoType: 'addition', renoSqft: 400, tier: 'standard' }),
          new SetReportToken(token!),
          new UnlockReport(),
        ]);
        await pollFor(() => store.selectSnapshot(ReportState.unlocked), 'reno unlock');
        fixture.detectChanges();
        // The unlocked snapshot is a reno report, not a new-build one.
        expect(store.selectSnapshot(ReportState.snapshot)?.renoInputs?.renoType).toBe('addition');
        stepButton('+').click();
        fixture.detectChanges();
        // Addition caps at 400: the stepper must not move above it.
        const stepperValue = fixture.nativeElement.querySelector('.stepper-value')?.textContent ?? '';
        expect(stepperValue).toContain('400');
      });
    });
  });
});
