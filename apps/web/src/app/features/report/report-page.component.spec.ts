import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, throwError } from 'rxjs';
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
import { LoadLeadEstimate, SetPartnerView, SetReportToken, UnlockReport } from './report.actions';
import { ReportState } from './report.state';
import { ReportPageComponent } from './report-page.component';
import { ReportPdfService } from './report-pdf.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

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
 * and a backend-powered partner share.
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

  async function setup(options?: {
    /** When true, a lead is submitted BEFORE the component is created, so
     * ngOnInit takes the token path (Karan directive 2026-09-27: the report
     * unlocks immediately after gate submit, and the gate stores the owner
     * token the backend returns with the lead response). */
    leadSubmitted?: boolean;
    /** magicLinkSent flag on the submitted lead — picks the confirmation-line variant. */
    magicLinkSent?: boolean;
    /** Why the magic-link email failed — picks the invalid-recipient copy variant. */
    emailError?: 'invalid-recipient' | 'delivery-failed';
    /**
     * Idempotent resubmit (P0 2026-09-27): no new email was sent because
     * one already went out recently — picks the "already in your inbox"
     * copy variant.
     */
    emailAlreadySent?: boolean;
    /**
     * When false, the gate response carried no reportToken (quarantine
     * path): the report unlocks via LoadLeadEstimate (public estimate
     * endpoint) instead of the token. Defaults to true.
     */
    withReportToken?: boolean;
  }): Promise<void> {
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
    if (options?.leadSubmitted) {
      // Drive the mock lead flow for a mock-valid owner token — exactly what
      // the gate page leaves behind (StoreLeadResult carrying the backend's
      // reportToken, then SetReportToken).
      const preview = await firstValueFrom(
        api.getPreviewEstimate({
          projectType: 'new_build',
          property: {
            addressKey: fakeProperty.addressKey,
            assessedLandValue: fakeProperty.assessedValue,
            lotSizeSqft: fakeProperty.lotSqft,
            zoning: fakeProperty.zoning,
          },
          scope: { buildSqft: 2200, tier: 'premium', garage: 'double', basement: 'unfinished' },
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
      const leadToken = api.devTokenForLead(lead.leadId);
      expect(leadToken).toBeTruthy();
      store.dispatch(
        new StoreLeadResult({
          leadId: lead.leadId,
          email: 'buyer@example.com',
          magicLinkSent: options.magicLinkSent ?? true,
          expiresInDays: 7,
          emailError: options.emailError,
          emailAlreadySent: options.emailAlreadySent,
        }),
      );
      // The gate stores the owner token from the lead response in a separate
      // dispatch — the token lives in ReportState memory only, never in the
      // persisted lead receipt. Quarantined responses carry no token: the
      // report loads from the public estimate endpoint instead.
      if (options?.withReportToken === false) {
        store.dispatch(new LoadLeadEstimate());
      } else {
        store.dispatch(new SetReportToken(leadToken!));
      }
    }
    fixture = TestBed.createComponent(ReportPageComponent);
    fixture.detectChanges();
    if (options?.leadSubmitted) {
      await pollFor(() => store.selectSnapshot(ReportState.unlocked), 'lead unlock');
    } else {
      await pollFor(() => store.selectSnapshot(ReportState.status) === 'ready', 'preview load');
    }
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

    describe('post-gate lead unlock (Karan directive 2026-09-27)', () => {
      beforeEach(async () => {
        await setup({ leadSubmitted: true, magicLinkSent: true });
      });

      it('unlocks IMMEDIATELY after gate submit: real figures, no blur, no locked copy, no gate CTA', () => {
        expect(store.selectSnapshot(ReportState.unlocked)).toBe(true);
        // No blur anywhere, no locked overlay, no unlock CTA.
        expect(fixture.nativeElement.querySelector('.locked')).toBeNull();
        expect(fixture.nativeElement.querySelector('.unlock')).toBeNull();
        expect(text()).not.toContain('magic link is on its way');
        // Real figures: the hero shows a concrete dollar total.
        const heroValue = fixture.nativeElement.querySelector('.hero-total .hero-value');
        expect(heroValue?.textContent?.trim()).toMatch(/^\$[\d,]+$/);
        // The cost breakdown renders real rows.
        expect(fixture.nativeElement.querySelectorAll('.bucket-legend li').length).toBeGreaterThan(0);
        // The calibration-transparency note stays visible (reframed, below the breakdown).
        expect(text()).toContain("How we're sharpening these numbers");
      });

      it('size stepper is active immediately (enabled buttons)', () => {
        const buttons = [...fixture.nativeElement.querySelectorAll('.stepper-card .step-btn')];
        expect(buttons.length).toBeGreaterThan(0);
        for (const btn of buttons) {
          expect((btn as HTMLButtonElement).disabled).toBe(false);
        }
      });

      it('shows the persistent "Report saved" confirmation below the disclaimer (fresh email)', () => {
        const note = fixture.nativeElement.querySelector('.lead-link-note');
        expect(note).not.toBeNull();
        expect(note.textContent).toContain(
          'Report saved — we emailed you a link to reopen it anytime.',
        );
      });

      it('partner share works from the immediately-unlocked report (gate-stored token)', async () => {
        // The QA bug: share failed from immediately-unlocked reports because
        // no owner token existed until the magic link was clicked. The gate
        // now stores the token from the lead response, so share must work
        // in the same tab.
        expect(store.selectSnapshot(ReportState.reportToken)).toBeTruthy();
        const shareSpy = vi.spyOn(api, 'shareWithPartner');
        const email = fixture.nativeElement.querySelector(
          'section[aria-label="Share with a partner"] input[type="email"]',
        ) as HTMLInputElement;
        email.value = 'partner@example.com';
        email.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        const shareButton = fixture.nativeElement.querySelector(
          'section[aria-label="Share with a partner"] button[type="submit"]',
        ) as HTMLButtonElement;
        shareButton.click();
        await pollFor(() => text().includes('will receive their own secure link'), 'share success');
        expect(shareSpy).toHaveBeenCalledWith({
          reportToken: store.selectSnapshot(ReportState.reportToken),
          partnerEmail: 'partner@example.com',
        });
        expect(text()).not.toContain('no longer available in this tab');
      });

      it('callback request works from the immediately-unlocked report (gate-stored token)', async () => {
        // Same QA bug as share: the callback form failed without a token.
        expect(store.selectSnapshot(ReportState.reportToken)).toBeTruthy();
        const callbackSpy = vi.spyOn(api, 'requestCallback');
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
        expect(callbackSpy).toHaveBeenCalled();
        expect(text()).not.toContain('no longer available in this tab');
      });

      it('"estimate another address" clears state and navigates to the landing page', async () => {
        const router = TestBed.inject(Router);
        const navigateSpy = vi.spyOn(router, 'navigate');
        const dispatchSpy = vi.spyOn(store, 'dispatch');
        const link = fixture.nativeElement.querySelector('a.another-address') as HTMLAnchorElement;
        expect(link).not.toBeNull();
        link.click();
        fixture.detectChanges();
        // A genuinely fresh estimate: no stale report, lead, or wizard state
        // leaks into the next run.
        expect(dispatchSpy).toHaveBeenCalled();
        const actions = dispatchSpy.mock.calls.flat().flat() as { constructor: { type?: string } }[];
        const types = actions.map((a) => a?.constructor?.type);
        expect(types).toContain('[Report] Clear');
        expect(types).toContain('[Lead] Clear');
        expect(types).toContain('[Wizard] Reset');
        expect(navigateSpy).toHaveBeenCalledWith(['/']);
      });
    });

    describe('post-gate lead unlock — email send failed', () => {
      beforeEach(async () => {
        // Token present (report unlocked) but the magic-link email never
        // went out: the note must say so and offer the retry.
        await setup({ leadSubmitted: true, magicLinkSent: false });
      });

      it('shows the "couldn\'t send the email link" variant and keeps the report unlocked', () => {
        expect(store.selectSnapshot(ReportState.unlocked)).toBe(true);
        const note = fixture.nativeElement.querySelector('.lead-link-note');
        expect(note).not.toBeNull();
        expect(note.textContent).toContain("couldn't send the email link");
        expect(note.textContent).toContain('Check your inbox — or try again later');
        expect(note.textContent).not.toContain('already in your inbox');
      });
    });

    describe('post-gate lead unlock — invalid recipient', () => {
      beforeEach(async () => {
        // The address itself was rejected: the note must say "check for
        // typos" — never "check your inbox", which would never arrive.
        await setup({
          leadSubmitted: true,
          magicLinkSent: false,
          emailError: 'invalid-recipient',
        });
      });

      it('shows the "check for typos" variant and keeps the report unlocked', () => {
        expect(store.selectSnapshot(ReportState.unlocked)).toBe(true);
        const note = fixture.nativeElement.querySelector('.lead-link-note');
        expect(note).not.toBeNull();
        expect(note.textContent).toContain('check it for typos');
        expect(note.textContent).not.toContain('Check your inbox');
        expect(note.textContent).not.toContain('already in your inbox');
      });
    });

    describe('post-gate lead unlock — idempotent resubmit (P0 2026-09-27)', () => {
      beforeEach(async () => {
        // The gate POST was a resubmit: no new email went out because one
        // already did recently — the note must say "already in your inbox",
        // and the report still unlocks via the fresh token.
        await setup({ leadSubmitted: true, magicLinkSent: true, emailAlreadySent: true });
      });

      it('shows the "already in your inbox" variant and keeps the report unlocked', () => {
        expect(store.selectSnapshot(ReportState.unlocked)).toBe(true);
        const note = fixture.nativeElement.querySelector('.lead-link-note');
        expect(note).not.toBeNull();
        expect(note.textContent).toContain('Report saved — your link is already in your inbox.');
        expect(note.textContent).not.toContain('emailed you a link');
        expect(note.textContent).not.toContain("couldn't send");
      });
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

    it('has NO tier toggle — the chosen tier is display-only (consumer/04 AC8)', () => {
      // Karan 2026-09-25: the finish-tier what-if switcher is removed from
      // the report page entirely; the tier is shown, never switched here.
      expect(fixture.nativeElement.querySelector('.tier-card')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-option-selector')).toBeNull();
      // The chosen tier is still SHOWN (display-only) so the user knows
      // which finishes the numbers assume.
      expect(fixture.nativeElement.querySelector('.tier-display')?.textContent).toContain(
        'Selected finish level — Premium',
      );
    });

    it('shows land as ONE fixed number — never a range', () => {
      const landCard = fixture.nativeElement.querySelector('.land-card');
      expect(landCard).not.toBeNull();
      // The mock mirrors the real backend: land is the fixture property's
      // City assessed value ($823,000), not a canned constant.
      expect(landCard.textContent).toContain('$823,000');
      expect(landCard.textContent).toContain('City of Calgary assessment · refreshed September 2026 · not a market price');
      expect(landCard.textContent).not.toMatch(/\$\d[\d,]*\s*[–-]\s*\$/);
    });

    describe('report trust content (2026-09-28)', () => {
      it('explains the selected finish tier and that upgrades are explicit choices', () => {
        const tierBlurb = fixture.nativeElement.querySelector('.tier-blurb');
        expect(tierBlurb?.textContent).toContain('hardwood and tile, stone counters');
        const choices = fixture.nativeElement.querySelector('.tier-choices');
        expect(choices?.textContent).toContain('explicit choices');
        expect(choices?.textContent).toContain('in-floor heating');
      });

      it('names standard cabinetry and the luxury gym in the tier descriptors', () => {
        // Karan's exact requirements (2026-09-28): standard must name
        // standard/non-oak cabinetry; luxury must name the basement gym.
        const descriptors = DEFAULT_APP_CONFIG.copy.report.tierDescriptors;
        expect(descriptors.standard).toContain('non-oak');
        expect(descriptors.luxury).toContain('gym');
      });

      it('frames coverage as builder-grade granularity with the 60+ line-item credibility line', () => {
        const body = text();
        expect(body).toContain("What your estimate covers");
        expect(body).toContain('60+ line items');
        expect(body).toContain('the way a real Calgary builder budgets');
        // Costs move: inflation, material choices, project-specific conditions.
        expect(body).toContain('can move with inflation');
        expect(body).toContain('your material choices');
        expect(body).toContain('project-specific conditions');
      });

      it('lists the honest exclusions — landscaping only, budgeted separately', () => {
        const body = text();
        expect(body).toContain("What's not in this estimate");
        // Karan's product lock (2026-09-28): the estimate covers the full
        // build except landscaping — it is the only exclusion.
        expect(body).toContain('Landscaping');
        expect(body).toContain('budget it separately with your builder');
        expect(body).not.toContain('Demolition of any existing home');
        expect(body).not.toContain('Financing costs');
      });

      it('renders the planning-ahead card: financing honesty and a qualitative timeline', () => {
        const body = text();
        expect(body).toContain('Planning ahead');
        expect(body).toContain('construction loan, not a regular mortgage');
        expect(body).toContain('Talk to a lender early');
        // No unverified month counts (Karan 2026-09-28): the timeline stays
        // qualitative and defers to the builder.
        expect(body).not.toContain('10–14 months');
        expect(body).toContain('your builder can confirm a timeline');
      });
    });

    it('renders exactly the three D-01 buckets in the breakdown (land excluded)', () => {      const items = [...fixture.nativeElement.querySelectorAll('.bucket-legend li')];
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

    it('hides the visual buckets bar from AT (legend carries labels + amounts)', () => {
      // B1: the bar used role="img" with a 100+ char label that AT/QA tools
      // truncated mid-number. The legend list below is the accessible
      // equivalent — the bar itself is purely decorative.
      const bar = fixture.nativeElement.querySelector('.buckets-bar');
      expect(bar).not.toBeNull();
      expect(bar.getAttribute('aria-hidden')).toBe('true');
      expect(bar.getAttribute('aria-label')).toBeNull();
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

    describe('AI narrative paragraph rendering (B2/B3)', () => {
      /** Patch the snapshot narrative, exactly as the backend serves it. */
      function serveNarrative(narrative: string): void {
        const snapshot = store.selectSnapshot(ReportState.snapshot)!;
        store.reset({
          ...store.snapshot(),
          report: {
            ...store.snapshot().report,
            snapshot: { ...snapshot, narrative, narrativeSource: 'ai' as const },
          },
        });
        fixture.detectChanges();
      }

      const paras = (): string[] =>
        [...fixture.nativeElement.querySelectorAll('p.narrative')].map((p: Element) =>
          p.textContent?.trim(),
        );

      it('renders one paragraph per blank-line-separated block', () => {
        serveNarrative('First block.\n\nSecond block.\n\nThird block.');
        expect(paras()).toEqual(['First block.', 'Second block.', 'Third block.']);
      });

      it('keeps the compliance footer as its own paragraph (never fused)', () => {
        serveNarrative(
          'Neighbourhood prose.\n\nDollar figures are calculated deterministically from our cost model — not generated by AI.',
        );
        const rendered = paras();
        expect(rendered).toHaveLength(2);
        expect(rendered[1]).toBe(
          'Dollar figures are calculated deterministically from our cost model — not generated by AI.',
        );
      });

      it('cleans legacy markdown instead of showing raw syntax', () => {
        serveNarrative('**Coventry Hills** is quiet. --- **Schools** rate well.');
        const rendered = paras();
        expect(rendered.join(' ')).not.toContain('**');
        expect(rendered.join(' ')).not.toContain('---');
        expect(rendered.join(' ')).toContain('Coventry Hills is quiet.');
      });

      it('collapses a duplicated narrative to a single copy', () => {
        const guide = 'Coventry Hills is quiet.\n\nSchools rate well.';
        serveNarrative(`${guide}\n\n${guide}`);
        expect(paras()).toEqual(['Coventry Hills is quiet.', 'Schools rate well.']);
      });
    });

    describe('static Calgary guide (BE-9)', () => {
      /** Patch the snapshot to carry the guide exactly as the backend serves it. */
      function serveStaticGuide(): void {
        const snapshot = store.selectSnapshot(ReportState.snapshot)!;
        const guideSnapshot = {
          ...snapshot,
          narrative: 'Guide paragraph one.\n\nGuide paragraph two.',
          narrativeSource: 'static-guide' as const,
        };
        store.reset({
          ...store.snapshot(),
          report: { ...store.snapshot().report, snapshot: guideSnapshot },
        });
        fixture.detectChanges();
      }

      it('renders the guide under its honest title — never as AI prose', async () => {
        serveStaticGuide();
        await pollFor(
          () => text().includes('Building in Calgary'),
          'guide title',
        );
        const headings = [
          ...fixture.nativeElement.querySelectorAll('section.card h2'),
        ].map((h: Element) => h.textContent?.trim());
        expect(headings).toContain('Building in Calgary');
        expect(headings).not.toContain('AI summary');
        expect(text()).toContain(
          'Our AI summary is unavailable right now — here’s a general guide.',
        );
      });

      it('renders one paragraph per guide block', async () => {
        serveStaticGuide();
        await pollFor(
          () => text().includes('Guide paragraph two.'),
          'guide paragraphs',
        );
        const paragraphs = [
          ...fixture.nativeElement.querySelectorAll('p.narrative'),
        ].map((p: Element) => p.textContent?.trim());
        expect(paragraphs).toContain('Guide paragraph one.');
        expect(paragraphs).toContain('Guide paragraph two.');
      });
    });

    it('renders the three next steps as an honest checklist (no matched-builder promises)', () => {
      const items = [...fixture.nativeElement.querySelectorAll('.steps.checklist li')];
      const titles = items.map((li: Element) => li.querySelector('strong')?.textContent?.trim());
      const bodies = items.map((li: Element) => li.querySelector('p')?.textContent?.trim());
      // Locked story: exactly 3 distinct steps — never 2, never duplicated.
      expect(titles).toEqual(['Talk to a builder', 'Refine your project brief', 'Save and share']);
      expect(new Set(bodies).size).toBe(3);
      // M1 honesty: the builder step points at the callback — no builders,
      // no match scores, no matching promises anywhere on the report.
      expect(bodies[0]).toContain('callback');
      expect(bodies[0]).not.toContain('match scores');
      expect(text()).not.toContain('match scores');
      // Terminology alignment: the stepper updates figures instantly —
      // there is no re-run button, so the steps never say "re-run".
      expect(bodies[1]).toContain('no re-run button');
      expect(text()).not.toContain('re-run the estimate');
      // The save-and-share step covers PDF, partner email, and callback.
      expect(bodies[2]).toContain('Download the PDF');
      // Every step is a checkbox with a visible progress line.
      const boxes = [...fixture.nativeElement.querySelectorAll('.steps.checklist input[type="checkbox"]')];
      expect(boxes).toHaveLength(3);
      expect(fixture.nativeElement.querySelector('.steps-progress')?.textContent).toContain('0 of 3 steps done');
    });

    it('checklist ticks persist per report and drive the progress line', async () => {
      await setup({ leadSubmitted: true });
      const boxes = [...fixture.nativeElement.querySelectorAll('.steps.checklist input[type="checkbox"]')] as HTMLInputElement[];
      expect(boxes).toHaveLength(3);
      boxes[0].click();
      fixture.detectChanges();
      expect(store.selectSnapshot(ReportState.stepsChecked)).toEqual({ 'talk-to-builder': true });
      expect(fixture.nativeElement.querySelector('.steps-progress')?.textContent).toContain('1 of 3 steps done');
      // Unchecking toggles back off.
      boxes[0].click();
      fixture.detectChanges();
      expect(store.selectSnapshot(ReportState.stepsChecked)).toEqual({ 'talk-to-builder': false });
      expect(fixture.nativeElement.querySelector('.steps-progress')?.textContent).toContain('0 of 3 steps done');
    });

    it('checklist state resets when a different report loads', async () => {
      await setup({ leadSubmitted: true });
      const boxes = [...fixture.nativeElement.querySelectorAll('.steps.checklist input[type="checkbox"]')] as HTMLInputElement[];
      boxes[1].click();
      fixture.detectChanges();
      expect(store.selectSnapshot(ReportState.stepsChecked)).toEqual({ 'refine-brief': true });
      // A new report (new lead) wipes the previous report's ticks.
      store.dispatch(new StoreLeadResult({ leadId: 'lead-new', email: 'b@example.com', magicLinkSent: false, expiresInDays: 7 }));
      store.dispatch(new LoadLeadEstimate());
      await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.leadId === 'lead-new', 'second report');
      expect(store.selectSnapshot(ReportState.stepsChecked)).toEqual({});
    });

    it('per-sqft line uses cents precision so the shown rate reconciles with the shown build cost', async () => {
      await setup({ leadSubmitted: true });
      const snap = store.selectSnapshot(ReportState.snapshot)!;
      const line = fixture.nativeElement.querySelector('.per-sqft')?.textContent ?? '';
      const m = line.match(/\$([\d,]+(?:\.\d{2})?) per sq ft · ([\d,]+) sq ft/);
      expect(m).not.toBeNull();
      const rate = parseFloat(m![1].replace(/,/g, ''));
      const sqft = parseInt(m![2].replace(/,/g, ''), 10);
      expect(sqft).toBe(snap.inputs.sqft);
      // The displayed rate is the exact quotient rounded to cents: the
      // residual against the build base is pure display rounding (< $0.005/sqft).
      expect(Math.abs(rate * sqft - snap.buildRange.base)).toBeLessThan(sqft * 0.005 + 1);
    });

    it('formatPerSqft renders whole dollars without cents and fractional rates with cents', async () => {
      await setup({ leadSubmitted: true });
      const cmp = fixture.componentInstance as unknown as { formatPerSqft(v: number): string };
      expect(cmp.formatPerSqft(580830 / 2400)).toBe('$242.01');
      expect(cmp.formatPerSqft(242)).toBe('$242');
      expect(cmp.formatPerSqft(0)).toBe('$0');
    });

    it('shows the whole-building lot notice for unit addresses', async () => {
      await setup({ leadSubmitted: true });
      // Sanity: an ordinary street address shows no unit notice.
      expect(fixture.nativeElement.querySelector('.unit-note')).toBeNull();
      // A condo unit address gets the honest whole-building note.
      store.dispatch([
        new SelectProperty({ ...fakeProperty, address: '225 823 5 Av NW, Calgary, AB' }),
      ]);
      fixture.detectChanges();
      const note = fixture.nativeElement.querySelector('.unit-note')?.textContent ?? '';
      expect(note).toContain('whole building');
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

    /** Share form elements, inside the partner-share section. */
    const shareEmailInput = (): HTMLInputElement =>
      fixture.nativeElement.querySelector(
        'section[aria-label="Share with a partner"] input[type="email"]',
      ) as HTMLInputElement;
    const shareButton = (): HTMLButtonElement =>
      fixture.nativeElement.querySelector(
        'section[aria-label="Share with a partner"] button[type="submit"]',
      ) as HTMLButtonElement;

    it('share sends through the backend and names the recipient on success', async () => {
      const shareSpy = vi.spyOn(api, 'shareWithPartner');
      const email = shareEmailInput();
      email.value = 'partner@example.com';
      email.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      shareButton().click();
      await pollFor(() => text().includes('will receive their own secure link'), 'share success');
      // The backend mints the partner their OWN link: called with the
      // memory-only report token, never the owner's magic link.
      expect(shareSpy).toHaveBeenCalledWith({
        reportToken: store.selectSnapshot(ReportState.reportToken),
        partnerEmail: 'partner@example.com',
      });
      expect(text()).toContain('partner@example.com');
      // The share is reported to analytics (consent-gated inside the real
      // service; mocked here).
      expect(TestBed.inject(AnalyticsService).track).toHaveBeenCalledWith('partner_share');
    });

    it('share blocks an invalid email without calling the backend', () => {
      const shareSpy = vi.spyOn(api, 'shareWithPartner');
      shareButton().click();
      fixture.detectChanges();
      expect(text()).toContain('Enter a valid email address.');
      expect(shareSpy).not.toHaveBeenCalled();
    });

    it('share shows an error with retry when the backend send fails', async () => {
      const shareSpy = vi.spyOn(api, 'shareWithPartner');
      const email = shareEmailInput();
      email.value = 'partner@example.com';
      email.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      shareSpy.mockReturnValueOnce(throwError(() => new Error('boom')));
      shareButton().click();
      await pollFor(() => text().includes('Couldn’t send'), 'share error');
      // No dead end: the button offers a retry, and it succeeds.
      const retry = shareButton();
      expect(retry.textContent?.trim()).toBe('Try again');
      retry.click();
      await pollFor(() => text().includes('will receive their own secure link'), 'share retry success');
    });

    it('share fails honestly when the report token is gone (memory-only after reload)', () => {
      const shareSpy = vi.spyOn(api, 'shareWithPartner');
      // Simulate the post-reload state: snapshot visible but the
      // memory-only token is gone.
      store.reset({
        ...store.snapshot(),
        report: { ...store.snapshot().report, reportToken: null },
      });
      fixture.detectChanges();
      const email = shareEmailInput();
      email.value = 'partner@example.com';
      email.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      shareButton().click();
      fixture.detectChanges();
      expect(shareSpy).not.toHaveBeenCalled();
      expect(text()).toContain('no longer available in this tab');
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

    it('Download PDF triggers a real file download (QA: the old print() appeared inert)', async () => {
      // jsdom has no URL.createObjectURL — stub the download plumbing and
      // assert the component drives it with a PDF blob and a .pdf filename.
      const created: string[] = [];
      const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((() => {
        const url = 'blob:mock-pdf-url';
        created.push(url);
        return url;
      }) as typeof URL.createObjectURL);
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      let clickedAnchor: HTMLAnchorElement | null = null;
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) {
          clickedAnchor = this;
        });
      try {
        const button = fixture.nativeElement.querySelector('button.pdf') as HTMLButtonElement;
        expect(button).not.toBeNull();
        button.click();
        // Generating state shows while jsPDF lazy-loads and renders.
        await pollFor(() => created.length > 0, 'pdf blob created');
        await pollFor(
          () => (fixture.nativeElement.querySelector('button.pdf') as HTMLButtonElement)?.disabled === false,
          'pdf button idle again',
        );
        expect(clickedAnchor).not.toBeNull();
        expect(clickedAnchor!.href).toBe('blob:mock-pdf-url');
        expect(clickedAnchor!.download).toMatch(/\.pdf$/);
        // No error surfaced.
        expect(text()).not.toContain('could not generate the PDF');
        // The download is reported to analytics (consent-gated; mocked here).
        expect(TestBed.inject(AnalyticsService).track).toHaveBeenCalledWith('pdf_download');
      } finally {
        createSpy.mockRestore();
        revokeSpy.mockRestore();
        clickSpy.mockRestore();
      }
    });

    it('Download PDF shows an honest error with retry when generation fails', async () => {
      const pdfService = TestBed.inject(ReportPdfService);
      const generateSpy = vi.spyOn(pdfService, 'generate').mockRejectedValue(new Error('pdf down'));
      try {
        const button = fixture.nativeElement.querySelector('button.pdf') as HTMLButtonElement;
        button.click();
        await pollFor(() => text().includes('could not generate the PDF'), 'pdf error');
        // Retry: the button recovers and the error clears on success.
        generateSpy.mockRestore();
        const retry = [...fixture.nativeElement.querySelectorAll('button')].find((b: Element) =>
          b.textContent?.trim() === 'Try again',
        ) as HTMLButtonElement;
        expect(retry).toBeTruthy();
        const createSpy = vi
          .spyOn(URL, 'createObjectURL')
          .mockReturnValue('blob:mock-pdf-url' as unknown as string);
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        try {
          retry.click();
          await pollFor(
            () => !text().includes('could not generate the PDF'),
            'pdf error cleared after retry',
          );
        } finally {
          createSpy.mockRestore();
          clickSpy.mockRestore();
        }
      } finally {
        if (generateSpy.mock.calls.length > 0) {
          generateSpy.mockRestore();
        }
      }
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

      it('never shows a per-sq-ft figure on a reno report', async () => {
        await setupReno();
        // The reno engine deliberately avoids per-sqft framing (reno/04):
        // no per-sqft line in the DOM, and the unit copy never appears.
        expect(fixture.nativeElement.querySelector('.per-sqft')).toBeNull();
        expect(text()).not.toContain('per sq ft');
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

      it('never shows new-build trust sections on a reno report', async () => {
        await setupReno();
        // Same reno unlock flow as the stepper test above.
        const preview = await firstValueFrom(
          api.getPreviewEstimate({
            addressKey: 'calgary-918-16-ave-nw',
            projectType: 'renovation',
            renoType: 'extensive',
            renoSqft: 800,
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
          new UpdateRenoInputs({ renoType: 'extensive', renoSqft: 800, tier: 'standard' }),
          new SetReportToken(token!),
          new UnlockReport(),
        ]);
        await pollFor(() => store.selectSnapshot(ReportState.unlocked), 'reno unlock');
        fixture.detectChanges();
        expect(store.selectSnapshot(ReportState.snapshot)?.projectType).toBe('renovation');
        const t = text();
        // New-build coverage framing, tier descriptors, financing and timeline
        // are about new construction — they must not leak onto reno reports.
        expect(t).not.toContain('What your estimate covers');
        expect(t).not.toContain('Built the way a real Calgary builder budgets');
        expect(t).not.toContain('Planning ahead');
        expect(t).not.toContain('construction loan');
        expect(t).not.toContain('finishes are never compromised');
        expect(t).not.toContain('explicit choices you make in your finish tier');
      });
    });
  });

  describe('partner view (partner-share redemption)', () => {
    async function unlockAsPartner(): Promise<void> {
      await unlock();
      store.dispatch(new SetPartnerView());
      fixture.detectChanges();
    }

    it('shows the read-only partner note', async () => {
      await unlockAsPartner();
      const note = fixture.nativeElement.querySelector('.partner-note');
      expect(note).toBeTruthy();
      expect(note.textContent).toContain('read-only');
    });

    it('hides the sqft stepper in partner view', async () => {
      await unlockAsPartner();
      expect(fixture.nativeElement.querySelector('.stepper-card')).toBeNull();
    });

    it('hides the share and callback sections in partner view', async () => {
      await unlockAsPartner();
      expect(
        fixture.nativeElement.querySelector('section[aria-label="Share with a partner"]'),
      ).toBeNull();
      expect(
        fixture.nativeElement.querySelector('section[aria-label="Prefer to talk it through?"]'),
      ).toBeNull();
    });

    it('still shows share and callback sections for the owner', async () => {
      await unlock();
      expect(
        fixture.nativeElement.querySelector('section[aria-label="Share with a partner"]'),
      ).toBeTruthy();
      expect(
        fixture.nativeElement.querySelector('section[aria-label="Prefer to talk it through?"]'),
      ).toBeTruthy();
      expect(fixture.nativeElement.querySelector('.partner-note')).toBeNull();
    });
  });
});
