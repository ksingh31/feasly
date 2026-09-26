import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { PropertyRecord, PreviewEstimateResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { provideApi } from '../../core/api/api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { ConfigService } from '../../core/config/config.service';
import { GoToStep, ChooseProjectType, LeadState, SelectProperty, WizardState } from '../wizard';
import { AnalyticsService } from '../consent';
import { EmbedState } from '../embed/embed.state';
import { EmbedConfigLoaded, EmbedConfigFailed, LoadEmbedConfig } from '../embed/embed.actions';
import { GatePageComponent } from './gate-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * FE-004: the single lead gate validates the form, POSTs the lead through
 * the ApiService, and routes to the analyzing screen — with honest errors.
 */
describe('GatePageComponent', () => {
  let store: Store;
  let router: Router;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<GatePageComponent>;

  const fakeProperty = {
    addressKey: 'calgary-1234-14-st-nw',
    address: '1234 14 St NW, Calgary, AB',
    community: 'Capitol Hill',
    lotSqft: 5000,
    zoning: 'R-CG',
    assessedValue: 729000,
    assessmentYear: 2025,
    yearBuilt: 1978,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  async function pollUrl(expected: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (router.url === expected) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expected}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function setInput(selector: string, value: string): void {
    const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function setSelect(value: string): void {
    const select = fixture.nativeElement.querySelector('#gate-timeline') as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function submit(): void {
    (fixture.nativeElement.querySelector('button.cta') as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  function fillValidForm(): void {
    setInput('#gate-name', 'Jane Doe');
    setInput('#gate-email', 'jane@example.com');
    setInput('#gate-phone', '');
    setSelect('');
  }

  async function setup(apiProvider: unknown = provideApi()): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [GatePageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        apiProvider as never,
        providePropertyData(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/analyzing', component: BlankComponent },
        ]),
        provideStore([WizardState, LeadState, EmbedState]),
        // The gate fires a consent-gated analytics event on success; the
        // gate spec owns gate behavior, not analytics internals.
        { provide: AnalyticsService, useValue: { track: vi.fn() } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    // Tiny mock latency; the gate/analyzing copy falls back to the compiled
    // defaults under test. propertyData.source=mock keeps the fixture harness.
    httpMock.expectOne('/assets/config/app-config.json').flush({
      timings: { mockLatencyMinMs: 1, mockLatencyMaxMs: 2 },
      propertyData: { source: 'mock' },
    });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    store.dispatch([new SelectProperty(fakeProperty), new GoToStep(3)]);
    fixture = TestBed.createComponent(GatePageComponent);
    fixture.detectChanges();
  }

  describe('form', () => {
    beforeEach(() => setup());

    it('renders name, email, phone, timeline, and CASL fields', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('#gate-name')).not.toBeNull();
      expect(el.querySelector('#gate-email')).not.toBeNull();
      expect(el.querySelector('#gate-phone')).not.toBeNull();
      expect(el.querySelector('#gate-timeline')).not.toBeNull();
      expect(el.querySelector('.casl input[type="checkbox"]')).not.toBeNull();
    });

    it('leaves the CASL opt-in unchecked by default', () => {
      const box = fixture.nativeElement.querySelector(
        '.casl input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(box.checked).toBe(false);
    });

    it('blocks an empty submit with inline errors and no navigation', async () => {
      submit();
      expect(fixture.nativeElement.querySelector('#gate-name-error')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('#gate-email-error')).not.toBeNull();
      expect(router.url).not.toBe('/estimate/analyzing');
    });

    it('rejects a malformed email', () => {
      setInput('#gate-name', 'Jane Doe');
      setInput('#gate-email', 'not-an-email');
      // Touch the email field so the error renders.
      const email = fixture.nativeElement.querySelector('#gate-email') as HTMLInputElement;
      email.dispatchEvent(new Event('blur'));
      submit();
      const error = fixture.nativeElement.querySelector('#gate-email-error') as HTMLElement;
      expect(error).not.toBeNull();
      expect(error.textContent).toContain('doesn\u2019t look right');
    });

    it('accepts an empty optional phone field', () => {
      setInput('#gate-phone', '');
      expect(fixture.nativeElement.querySelector('#gate-phone-error')).toBeNull();
    });

    it('rejects a malformed optional phone number', () => {
      setInput('#gate-phone', '!!!');
      const phone = fixture.nativeElement.querySelector('#gate-phone') as HTMLInputElement;
      phone.dispatchEvent(new Event('blur'));
      submit();
      expect(fixture.nativeElement.querySelector('#gate-phone-error')).not.toBeNull();
    });

    it('HRD-03: honeypot is invisible and keyboard-unfocusable', () => {
      const input = fixture.nativeElement.querySelector(
        '#gate-website',
      ) as HTMLInputElement;
      expect(input).toBeTruthy();
      // Visually hidden via the shared sr-only treatment …
      expect(input.closest('.sr-only')).toBeTruthy();
      // … removed from the accessibility tree …
      expect(input.closest('[aria-hidden="true"]')).toBeTruthy();
      // … skipped by keyboard navigation …
      expect(input.getAttribute('tabindex')).toBe('-1');
      // … and ignored by password managers / autofill.
      expect(input.getAttribute('autocomplete')).toBe('off');
    });
  });

  describe('submit (mock API)', () => {
    beforeEach(() => setup());

    it('POSTs the lead and routes to the analyzing screen', async () => {
      const mockApi = TestBed.inject(MockApiService);
      const submitSpy = vi.spyOn(mockApi, 'submitLead');
      setInput('#gate-name', 'Jane Doe');
      setInput('#gate-email', 'jane@example.com');
      setInput('#gate-phone', '');
      setSelect('3-6mo');
      (fixture.nativeElement.querySelector('.casl input') as HTMLInputElement).click();
      fixture.detectChanges();
      submit();
      await pollUrl('/estimate/analyzing');
      expect(submitSpy).toHaveBeenCalledOnce();
      const request = submitSpy.mock.calls[0][0];
      expect(request.name).toBe('Jane Doe');
      expect(request.email).toBe('jane@example.com');
      expect(request.phone).toBeUndefined();
      expect(request.timeline).toBe('3-6mo');
      expect(request.marketingConsent).toBe(true);
      expect(request.estimateId).toMatch(/^est-mock-/);
      expect(store.selectSnapshot(LeadState.leadId)).toMatch(/^lead-mock-/);
      expect(store.selectSnapshot(LeadState.email)).toBe('jane@example.com');
      // The gate conversion is reported to analytics (consent-gated inside
      // the real service; mocked here).
      expect(TestBed.inject(AnalyticsService).track).toHaveBeenCalledWith('gate_convert');
    });

    it('defaults an unchosen timeline to exploring', async () => {
      const mockApi = TestBed.inject(MockApiService);
      const submitSpy = vi.spyOn(mockApi, 'submitLead');
      fillValidForm();
      submit();
      await pollUrl('/estimate/analyzing');
      expect(submitSpy).toHaveBeenCalledOnce();
      expect(submitSpy.mock.calls[0][0].timeline).toBe('exploring');
      expect(store.selectSnapshot(LeadState.leadId)).toMatch(/^lead-mock-/);
    });

    it('HRD-03: sends an empty honeypot value for human submissions', async () => {
      const mockApi = TestBed.inject(MockApiService);
      const submitSpy = vi.spyOn(mockApi, 'submitLead');
      fillValidForm();
      submit();
      await pollUrl('/estimate/analyzing');
      expect(submitSpy).toHaveBeenCalledOnce();
      expect(submitSpy.mock.calls[0][0].website).toBe('');
    });

    it('HRD-03: forwards a filled honeypot value for the backend to quarantine', async () => {
      const mockApi = TestBed.inject(MockApiService);
      const submitSpy = vi.spyOn(mockApi, 'submitLead');
      fillValidForm();
      // Simulate a bot filling the hidden field.
      setInput('#gate-website', 'https://spam.example');
      submit();
      await pollUrl('/estimate/analyzing');
      expect(submitSpy).toHaveBeenCalledOnce();
      expect(submitSpy.mock.calls[0][0].website).toBe('https://spam.example');
    });
  });

  describe('submit failure', () => {
    const preview = {
      estimateId: 'est-mock-2200-standard',
      addressKey: fakeProperty.addressKey,
      inputs: { sqft: 2200, tier: 'standard', garage: 'double', basement: 'unfinished' },
      figures: { build: { blurred: true }, total: { blurred: true }, land: { blurred: true } },
      rows: [],
      costDataVersion: 'mock-v1',
      createdAt: '2026-09-24T00:00:00.000Z',
    } as PreviewEstimateResponse;

    let failNext = true;
    const stub = {
      getPreviewEstimate: () => of(preview),
      submitLead: () =>
        failNext ? throwError(() => new Error('offline')) : of({ leadId: 'lead-1', magicLinkSent: true, expiresInDays: 7 }),
    };

    beforeEach(async () => {
      failNext = true;
      await setup({ provide: API_SERVICE, useValue: stub });
    });

    it('shows an honest error with retry, and retry recovers', async () => {
      fillValidForm();
      submit();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.form-error')).not.toBeNull();
      });
      expect(router.url).not.toBe('/estimate/analyzing');

      failNext = false;
      (fixture.nativeElement.querySelector('.form-error .retry') as HTMLButtonElement).click();
      await pollUrl('/estimate/analyzing');
      expect(store.selectSnapshot(LeadState.leadId)).toBe('lead-1');
    });
  });

  describe('reno/06: project-type-aware gate copy', () => {
    function timelineLabelText(): string {
      const label = fixture.nativeElement.querySelector(
        'label[for="gate-timeline"]',
      ) as HTMLElement;
      return label.textContent ?? '';
    }

    it('shows the new-build timeline question by default', async () => {
      await setup();
      expect(timelineLabelText()).toContain('When are you hoping to build?');
      expect(timelineLabelText()).not.toContain('renovate');
    });

    it('shows the reno timeline question when projectType is renovation', async () => {
      await setup();
      await firstValueFrom(store.dispatch(new ChooseProjectType('renovation')));
      fixture.detectChanges();
      expect(timelineLabelText()).toContain('When are you hoping to renovate?');
      expect(timelineLabelText()).not.toContain('When are you hoping to build?');
    });

    it('shows the new-build timeline question when projectType is new-build', async () => {
      await setup();
      await firstValueFrom(store.dispatch(new ChooseProjectType('new-build')));
      fixture.detectChanges();
      expect(timelineLabelText()).toContain('When are you hoping to build?');
    });

    it('sources both variants from config copy (no hardcoded flow strings)', async () => {
      await setup();
      const config = TestBed.inject(ConfigService);
      const gate = config.get('copy').gate;
      expect(gate.timelineLabel).toBe('When are you hoping to build?');
      expect(gate.timelineLabelReno).toBe('When are you hoping to renovate?');
      // The component selects the variant; the template renders whichever
      // the getter returns — assert the getter tracks the store flag.
      await firstValueFrom(store.dispatch(new ChooseProjectType('renovation')));
      fixture.detectChanges();
      expect(timelineLabelText()).toContain(gate.timelineLabelReno);
    });

    it('keeps the headline, CASL default, and single timeline question unchanged', async () => {
      await setup();
      await firstValueFrom(store.dispatch(new ChooseProjectType('renovation')));
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.gate-heading')?.textContent).toContain(
        'Where should we send your estimate?',
      );
      const box = el.querySelector('.casl input[type="checkbox"]') as HTMLInputElement;
      expect(box.checked).toBe(false);
      // Exactly one timeline question on the page.
      expect(el.querySelectorAll('#gate-timeline').length).toBe(1);
    });
  });

  describe('EMB-03 embed attribution', () => {
    const acmeConfig = {
      business_name: 'Acme Builders Ltd.',
      display_name: 'Acme Builders',
      logo_url: '',
      accent_color: '#b08d57',
      allowed_origins: ['https://acme.example'],
      fallback_phone: '',
      fallback_email: '',
      plan: null,
    };

    const betaConfig = {
      ...acmeConfig,
      business_name: 'Beta Homes Inc.',
      display_name: 'Beta Homes',
    };

    beforeEach(() => setup());

    it('shows the consent line with the builder name from config', () => {
      store.dispatch(new LoadEmbedConfig('acme-builders'));
      store.dispatch(new EmbedConfigLoaded(acmeConfig as never));
      fixture.detectChanges();

      const consent = fixture.nativeElement.querySelector('.embed-consent') as HTMLElement;
      expect(consent).not.toBeNull();
      expect(consent.textContent).toContain('Acme Builders');
      expect(consent.textContent).toContain(
        'Your details go to Acme Builders, who may contact you about this estimate.',
      );
    });

    it('updates the consent line when the config has a different name', () => {
      store.dispatch(new LoadEmbedConfig('beta-homes'));
      store.dispatch(new EmbedConfigLoaded(betaConfig as never));
      fixture.detectChanges();

      const consent = fixture.nativeElement.querySelector('.embed-consent') as HTMLElement;
      expect(consent).not.toBeNull();
      expect(consent.textContent).toContain('Beta Homes');
      expect(consent.textContent).not.toContain('Acme Builders');
    });

    it('hides the consent line outside embed context', () => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.embed-consent')).toBeNull();
    });

    it('fail-closed: config failure shows the unavailable copy and no form', () => {
      store.dispatch(new LoadEmbedConfig('unknown-tenant'));
      store.dispatch(new EmbedConfigFailed('unknown_tenant'));
      fixture.detectChanges();

      const unavailable = fixture.nativeElement.querySelector(
        '.embed-unavailable',
      ) as HTMLElement;
      expect(unavailable).not.toBeNull();
      expect(unavailable.textContent).toContain(
        'This estimator is temporarily unavailable right now.',
      );
      // The gate form does not render — nothing can be collected.
      expect(fixture.nativeElement.querySelector('form.gate-form')).toBeNull();
      expect(fixture.nativeElement.querySelector('#gate-name')).toBeNull();
    });

    it('passes the tenant key through to the lead submission', async () => {
      const mockApi = TestBed.inject(MockApiService);
      const submitSpy = vi.spyOn(mockApi, 'submitLead');
      const previewSpy = vi.spyOn(mockApi, 'getPreviewEstimate');

      store.dispatch(new LoadEmbedConfig('acme-builders'));
      store.dispatch(new EmbedConfigLoaded(acmeConfig as never));
      fixture.detectChanges();

      fillValidForm();
      submit();
      await pollUrl('/estimate/analyzing');

      expect(submitSpy).toHaveBeenCalledOnce();
      expect(submitSpy.mock.calls[0][0].tenantKey).toBe('acme-builders');
      expect(previewSpy.mock.calls[0][0].tenantKey).toBe('acme-builders');

    });
  });
});
