/**
 * Admin calibration-console component tests (admin/09).
 *
 * Verifies:
 * - AC1: the version card shows the current cost-data version + report
 *   from the store (uncalibrated placeholder until the import lands).
 * - AC2: no inline param editing exists — the template contains no
 *   inputs bound to params, and the component exposes no write methods.
 * - The small-sample warning renders when present.
 * - Loading and error states render.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import { NEVER, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideStore, Store } from '@ngxs/store';
import { AdminCalibrationComponent } from './admin-calibration.component';
import { AdminCalibrationApiService } from './admin-calibration-api.service';
import {
  CalibrationState,
  type CalibrationStateModel,
} from './admin-calibration.state';
import { SeoService } from '../../core/seo/seo.service';
import type { AdminCalibrationResponse } from '@feasly/contracts';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

const CALIBRATION: AdminCalibrationResponse = {
  current: {
    version: 'v0.3.0-unclibrated',
    calibrated: false,
    frozen: false,
    source: 'placeholder stand-ins (uncalibrated)',
    notes: '',
    hardCostCategories: 8,
    softCostCategories: 5,
    tiers: ['standard', 'premium', 'luxury'],
  },
  report: {
    costDataVersion: 'v0.3.0-unclibrated',
    houses: [],
    errorDistribution: { buckets: [], counts: [] },
    sampleSize: 0,
    smallSampleWarning: 'No calibration data yet.',
    meanAbsoluteErrorFraction: null,
  },
  importHistory: [],
  hasDraftV2: false,
};

async function setup(
  state: Partial<CalibrationStateModel> = {},
  apiResponse: 'resolve' | 'never' = 'resolve',
) {
  TestBed.resetTestingModule();
  const api = {
    getCalibration: vi
      .fn()
      .mockReturnValue(apiResponse === 'never' ? NEVER : of(CALIBRATION)),
  };
  const seo = { setPage: vi.fn() };

  TestBed.configureTestingModule({
    imports: [AdminCalibrationComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '', component: BlankComponent }]),
      provideStore([CalibrationState]),
      { provide: AdminCalibrationApiService, useValue: api },
      { provide: SeoService, useValue: seo },
    ],
  });

  const store = TestBed.inject(Store);
  // Seed the state directly (bypasses the API for render assertions).
  store.reset({
    calibration: {
      calibration: state.calibration ?? CALIBRATION,
      status: state.status ?? 'ready',
      error: state.error ?? null,
    },
  });

  const fixture: ComponentFixture<AdminCalibrationComponent> =
    TestBed.createComponent(AdminCalibrationComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, store };
}

describe('AdminCalibrationComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC1: shows the current version card', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('v0.3.0-unclibrated');
    expect(el.textContent).toContain('Calibration console');
  });

  it('shows the small-sample warning when present', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('No calibration data yet.');
  });

  it('AC2: exposes no param-editing controls', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    // No text/number inputs for params — only buttons (retry, v2 import).
    const inputs = el.querySelectorAll('input');
    expect(inputs.length).toBe(0);
    // The component has no write methods on its public surface.
    const proto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(fixture.componentInstance),
    );
    expect(proto).not.toContain('updateParams');
    expect(proto).not.toContain('saveParams');
    expect(proto).not.toContain('freezeVersion');
  });

  it('renders the loading state', async () => {
    // The API never resolves, so the component stays in 'loading' after
    // ngOnInit dispatches LoadCalibration.
    const { fixture } = await setup(
      { calibration: null, status: 'loading' },
      'never',
    );
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Loading calibration');
  });

  it('renders the empty import-history state', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('No imports yet');
  });
});
