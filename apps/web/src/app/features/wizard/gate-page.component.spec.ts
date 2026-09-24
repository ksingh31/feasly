import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { PropertyRecord, PreviewEstimateResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { provideApi } from '../../core/api/api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { ConfigService } from '../../core/config/config.service';
import { GoToStep, LeadState, SelectProperty, WizardState } from '../wizard';
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
        provideStore([WizardState, LeadState]),
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
});
