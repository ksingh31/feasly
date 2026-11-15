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

const LOADED: AdminCalibrationResponse = {
  current: {
    version: 'v3',
    calibrated: true,
    frozen: true,
    source: 'cost sheet',
    notes: '',
    hardCostCategories: 8,
    softCostCategories: 5,
    tiers: ['standard', 'premium', 'luxury'],
  },
  report: {
    costDataVersion: 'v3',
    houses: [
      { houseId: 'h-1', actualTotalCents: 65_000_000, engineTotalCents: 68_380_000, errorFraction: 0.052 },
      { houseId: 'h-2', actualTotalCents: 70_000_000, engineTotalCents: 67_830_000, errorFraction: -0.031 },
      { houseId: 'h-3', actualTotalCents: 80_000_000, engineTotalCents: 84_800_000, errorFraction: 0.06 },
    ],
    errorDistribution: { buckets: ['-10–0%', '0–10%', '10%+'], counts: [1, 2, 0] },
    sampleSize: 3,
    smallSampleWarning: 'Only 3 calibration houses — treat error figures as directional.',
    meanAbsoluteErrorFraction: 0.047,
  },
  importHistory: [
    { id: 'i-2', importedAt: '2026-11-02T17:30:00.000Z', version: 'v4', houseCount: 3, importedBy: 'ops@feasly.ca', status: 'draft' },
    { id: 'i-1', importedAt: '2026-10-31T17:30:00.000Z', version: 'v3', houseCount: 3, importedBy: 'ops@feasly.ca', status: 'frozen' },
  ],
  hasDraftV2: true,
};

async function setup(
  state: Partial<CalibrationStateModel> = {},
  apiResponse: 'resolve' | 'never' = 'resolve',
) {
  TestBed.resetTestingModule();
  const api = {
    getCalibration: vi
      .fn()
      .mockReturnValue(apiResponse === 'never' ? NEVER : of(state.calibration ?? CALIBRATION)),
  };

  TestBed.configureTestingModule({
    imports: [AdminCalibrationComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '', component: BlankComponent }]),
      provideStore([CalibrationState]),
      { provide: AdminCalibrationApiService, useValue: api },
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
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Calibration');
  });

  it('suppresses the small-sample warning at n=0 (review B11)', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).not.toContain('No calibration data yet.');
    expect(el.textContent).toContain('No houses in the report yet');
    // No internal dev copy leaks into the UI.
    expect(el.textContent).not.toContain('Karan');
    expect(el.textContent).not.toContain('cost-engine/01');
  });

  it('shows the small-sample warning when there are houses', async () => {
    const { fixture } = await setup({ calibration: LOADED });
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Only 3 calibration houses');
  });

  it('renders the report with an unsigned mean absolute error (review B23)', async () => {
    const { fixture } = await setup({ calibration: LOADED });
    const el: HTMLElement = fixture.nativeElement;
    const meta = el.querySelector('.calibration__meta')!.textContent!;
    expect(meta).toContain('4.7%');
    expect(meta).not.toContain('+4.7%');
    // Per-house errors keep their sign; money is whole dollars.
    expect(el.textContent).toContain('+5.2%');
    expect(el.textContent).toContain('$650,000');
  });

  it('renders zero histogram buckets without a bar', async () => {
    const { fixture } = await setup({ calibration: LOADED });
    const el: HTMLElement = fixture.nativeElement;
    const rows = Array.from(el.querySelectorAll('.histogram__row'));
    expect(rows.length).toBe(3);
    const empty = rows.filter((r) => r.classList.contains('histogram__row--empty'));
    expect(empty.length).toBe(1);
    expect(empty[0].querySelector('.histogram__bar')).toBeNull();
    expect(el.querySelector('.histogram__axis')).not.toBeNull();
  });

  it('formats import dates via the kit pipe and shows status chips (review B10)', async () => {
    const { fixture } = await setup({ calibration: LOADED });
    const el: HTMLElement = fixture.nativeElement;
    const text = el.textContent ?? '';
    expect(text).not.toContain('2026-10-31T17:30:00.000Z');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).toContain('Oct 31, 2026 · 11:30 a.m. MT');
    const chips = Array.from(el.querySelectorAll('ui-status-chip')).map((c) => c.textContent?.trim());
    expect(chips).toContain('Draft');
    expect(chips).toContain('Frozen');
  });

  it('derives the next-calibration copy from the payload (review B10)', async () => {
    const { fixture } = await setup({ calibration: LOADED });
    const el: HTMLElement = fixture.nativeElement;
    const text = el.textContent ?? '';
    expect(text).toContain('The v4 draft import is in progress. v3 stays live');
    expect(text).not.toContain('v2 draft');
    expect(text).not.toContain('frozen v1');
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

  it('uses only kit buttons — no unstyled native controls (#547 AC1)', async () => {
    const { fixture } = await setup({ calibration: LOADED });
    const el: HTMLElement = fixture.nativeElement;
    const buttons = Array.from(el.querySelectorAll('button')).filter(
      (b) => !b.closest('ui-data-table, ui-error-state, ui-empty-state'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.classList.contains('ui-button'), button.textContent?.trim()).toBe(true);
    }
    const start = el.querySelector('[data-testid="start-import"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('aria-describedby')).toBe('next-import-hint');
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
