import { ChangeDetectorRef, Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { PreviewEstimateResponse, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE, provideApi } from '../../core/api/api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { GoToStep, SelectProperty, WizardState } from '../wizard';
import { AnalyzingPageComponent } from './analyzing-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * FE-004: the analyzing screen runs the real pipeline (validate → fetch →
 * estimate), stores the blurred preview, and routes to the report — with an
 * honest error state and retry.
 */
describe('AnalyzingPageComponent', () => {
  let store: Store;
  let router: Router;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<AnalyzingPageComponent>;

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

  const fakePreview = {
    estimateId: 'est-mock-2200-standard',
    addressKey: fakeProperty.addressKey,
    inputs: { sqft: 2200, tier: 'standard', garage: 'double', basement: 'unfinished' },
    figures: { build: { blurred: true }, total: { blurred: true }, land: { blurred: true } },
    rows: [],
    costDataVersion: 'mock-v1',
    createdAt: '2026-09-24T00:00:00.000Z',
  } as PreviewEstimateResponse;

  async function pollUrl(expected: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (router.url === expected) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expected}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function stageState(key: string): string | null {
    const stages = fixture.nativeElement.querySelectorAll('.stage');
    const labels: Record<string, number> = { validate: 0, fetch: 1, estimate: 2 };
    return stages[labels[key]]?.getAttribute('data-state') ?? null;
  }

  /**
   * ComponentFixture.detectChanges() does not refresh the DOM in this
   * repo's unit-test setup (Angular 22 application builder + vitest); the
   * component's own ChangeDetectorRef does.
   */
  function refresh(): void {
    fixture.debugElement.injector.get(ChangeDetectorRef).detectChanges();
  }

  async function setup(apiProvider: unknown = provideApi()): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AnalyzingPageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        apiProvider as never,
        providePropertyData(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/report', component: BlankComponent },
        ]),
        provideStore([WizardState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      timings: { mockLatencyMinMs: 1, mockLatencyMaxMs: 2 },
      propertyData: { source: 'mock' },
    });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
  }

  describe('successful pipeline (mock API)', () => {
    beforeEach(async () => {
      await setup();
      store.dispatch([new SelectProperty(fakeProperty), new GoToStep(3)]);
      fixture = TestBed.createComponent(AnalyzingPageComponent);
      fixture.detectChanges();
    });

    it('stores the blurred preview and routes to the report', async () => {
      await pollUrl('/estimate/report');
      const preview = store.selectSnapshot(WizardState.preview);
      expect(preview?.estimateId).toMatch(/^est-mock-/);
      // Pre-gate shape: blurred figures only, never real dollar amounts.
      expect(preview?.figures.build).toEqual({ blurred: true });
      expect(preview?.figures.total).toEqual({ blurred: true });
      expect(preview?.rows).toEqual([]);
    });
  });

  describe('stage transitions (controlled stub)', () => {
    let propertyCalls: Subject<PropertyRecord>;
    let estimateCalls: Subject<PreviewEstimateResponse>;

    beforeEach(async () => {
      propertyCalls = new Subject<PropertyRecord>();
      estimateCalls = new Subject<PreviewEstimateResponse>();
      await setup({
        provide: API_SERVICE,
        useValue: {
          getProperty: () => propertyCalls.asObservable(),
          getPreviewEstimate: () => estimateCalls.asObservable(),
        },
      });
      store.dispatch([new SelectProperty(fakeProperty), new GoToStep(3)]);
      fixture = TestBed.createComponent(AnalyzingPageComponent);
      fixture.detectChanges();
    });

    it('each stage flips only when its real work resolves', async () => {
      // Validate is synchronous and real: already done; fetch is in flight.
      expect(stageState('validate')).toBe('done');
      expect(stageState('fetch')).toBe('active');
      expect(stageState('estimate')).toBe('pending');

      fixture.ngZone?.run(() => propertyCalls.next(fakeProperty));
      refresh();
      expect(stageState('fetch')).toBe('done');
      expect(stageState('estimate')).toBe('active');

      fixture.ngZone?.run(() => estimateCalls.next(fakePreview));
      refresh();
      expect(stageState('estimate')).toBe('done');
      expect(store.selectSnapshot(WizardState.preview)?.estimateId).toBe(
        'est-mock-2200-standard',
      );
    });
  });

  describe('failure (mock API)', () => {
    const bogusProperty = { ...fakeProperty, addressKey: 'calgary-000-0-nowhere' } as PropertyRecord;

    beforeEach(async () => {
      await setup();
      store.dispatch([new SelectProperty(bogusProperty), new GoToStep(3)]);
      fixture = TestBed.createComponent(AnalyzingPageComponent);
      fixture.detectChanges();
    });

    it('shows an honest error and retry recovers after fixing the input', async () => {
      await vi.waitFor(() => {
        refresh();
        expect(fixture.nativeElement.querySelector('.error-card')).not.toBeNull();
      });
      expect(stageState('fetch')).toBe('error');
      expect(router.url).not.toBe('/estimate/report');
      expect(store.selectSnapshot(WizardState.preview)).toBeNull();

      store.dispatch(new SelectProperty(fakeProperty));
      (fixture.nativeElement.querySelector('.error-card .cta') as HTMLButtonElement).click();
      await pollUrl('/estimate/report');
      expect(store.selectSnapshot(WizardState.preview)?.estimateId).toMatch(/^est-mock-/);
    });
  });
});
