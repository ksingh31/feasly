import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { PreviewEstimateResponse, PropertyRecord, ReportSnapshot } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api';
import type { ApiService } from '../../core/api';
import { ConfigService } from '../../core/config';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { LeadState, SelectProperty, StorePreviewEstimate, WizardState } from '../wizard';
import { ReportState } from '../report/report.state';
import { AnalyticsService } from '../consent/analytics.service';
import { LandingPageComponent } from './landing-page.component';

@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * #704: returning users. The landing page links to `/my-report` under the
 * address box, and — when this browser holds an in-progress estimate or a
 * stored report — shows a one-line "Continue your estimate for {address}"
 * chip with a dismiss control. Dismissal lasts until the next new estimate.
 */
describe('LandingPageComponent returning users (#704)', () => {
  const copy = DEFAULT_APP_CONFIG.copy.returning;
  let fixture: ComponentFixture<LandingPageComponent>;
  let store: Store;
  let track: ReturnType<typeof vi.fn>;

  const property = {
    addressKey: 'calgary-1234-14-st-nw',
    address: '1234 14 St NW, Calgary, AB',
    community: 'Capitol Hill',
    lotSqft: 5000,
    zoning: 'R-C1',
    assessedValue: 729000,
    assessmentYear: 2025,
    yearBuilt: 1978,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  async function open(seed?: (store: Store) => void): Promise<void> {
    TestBed.resetTestingModule();
    track = vi.fn();
    const api = {
      autocomplete: vi.fn().mockReturnValue(of([])),
      getCityDataFreshness: vi.fn().mockReturnValue(of({ rollYear: null, refreshedMonth: null })),
    };
    TestBed.configureTestingModule({
      imports: [LandingPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_SERVICE, useValue: api as unknown as ApiService },
        { provide: AnalyticsService, useValue: { track } },
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'my-report', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/preview', component: BlankComponent },
          { path: 'estimate/report', component: BlankComponent },
        ]),
        provideStore([WizardState, LeadState, ReportState]),
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { useMockApi: false },
      propertyData: { source: 'mock' },
    });
    await pending;
    store = TestBed.inject(Store);
    seed?.(store);
    fixture = TestBed.createComponent(LandingPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function chip(): HTMLElement | null {
    return el().querySelector('.resume-chip');
  }

  function seedReport(s: Store): void {
    s.reset({
      ...s.snapshot(),
      report: {
        ...s.snapshot().report,
        snapshot: { addressKey: property.addressKey, leadId: 'lead-1' } as ReportSnapshot,
      },
    });
  }

  it('links to /my-report under the address box (one click to the form)', async () => {
    await open();
    const link = el().querySelector('.find-report a') as HTMLAnchorElement;
    expect(el().querySelector('.find-report')?.textContent).toContain(copy.findReportPrompt);
    expect(link.textContent).toContain(copy.findReportLink);
    expect(link.getAttribute('href')).toBe('/my-report');
  });

  it('renders no chip without stored state', async () => {
    await open();
    expect(chip()).toBeNull();
  });

  it('shows the chip for a stored report and continues to the report', async () => {
    await open((s) => {
      s.dispatch(new SelectProperty(property));
      seedReport(s);
    });
    expect(chip()?.textContent).toContain(
      copy.resumeLabel.replace('{address}', property.address),
    );
    const link = chip()?.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/estimate/report');
    link.click();
    expect(track).toHaveBeenCalledWith('report_resume');
  });

  it('continues an in-progress estimate at the preview, else the scope step', async () => {
    await open((s) => {
      s.dispatch(new SelectProperty(property));
      s.dispatch(new StorePreviewEstimate({ estimateId: 'est-1' } as PreviewEstimateResponse));
    });
    expect(chip()?.querySelector('a')?.getAttribute('href')).toBe('/estimate/preview');

    await open((s) => s.dispatch(new SelectProperty(property)));
    expect(chip()?.querySelector('a')?.getAttribute('href')).toBe('/estimate/scope');
  });

  it('dismissing hides the chip until the next new estimate', async () => {
    await open((s) => {
      s.dispatch(new SelectProperty(property));
      seedReport(s);
    });
    const dismiss = chip()?.querySelector('button') as HTMLButtonElement;
    expect(dismiss.getAttribute('aria-label')).toBe(copy.resumeDismissLabel);
    dismiss.click();
    fixture.detectChanges();
    expect(chip()).toBeNull();
    expect(store.selectSnapshot(WizardState.resumeDismissed)).toBe(true);

    // Still hidden after a reload of the page (persisted wizard state).
    const persisted = store.snapshot();
    await open((s) => s.reset(persisted));
    expect(chip()).toBeNull();

    // A new estimate (newly selected property) brings it back.
    store.dispatch(new SelectProperty({ ...property }));
    fixture.detectChanges();
    expect(chip()).not.toBeNull();
  });
});
