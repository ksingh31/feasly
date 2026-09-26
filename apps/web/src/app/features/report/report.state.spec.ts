import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, Subject } from 'rxjs';
import type { PropertyRecord, TierRevisionRequest, TierRevisionResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { mockReport } from '../../core/api/mock-data';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { SelectProperty, UpdateInputs, WizardState } from '../wizard';
import { ClearReport, LoadPreview, ReviseReport, SetReportToken, UnlockReport } from './report.actions';
import { ReportState } from './report.state';

/**
 * ReportState holds the blurred preview pre-gate and the verified snapshot
 * post-gate; the component never touches the API directly. Revisions carry
 * switchMap semantics (cancelUncompleted): a stale in-flight response can
 * never overwrite a newer snapshot.
 */
describe('ReportState', () => {
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

  const baseInputs = { sqft: 2200, tier: 'premium', garage: 'double', basement: 'unfinished' } as const;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideStore([WizardState, ReportState])],
    });
    // provideApi is a factory provider; register it explicitly.
    TestBed.configureTestingModule({
      providers: [providePropertyData(), { provide: API_SERVICE, useClass: MockApiService }],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    store = TestBed.inject(Store);
    api = TestBed.inject(API_SERVICE) as MockApiService;
  }

  beforeEach(async () => {
    await setup();
  });

  /** Polls until the predicate holds — never a fixed sleep. */
  async function pollFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (predicate()) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Polls the report status until it settles — never a fixed sleep. */
  async function pollStatus(expected: string): Promise<void> {
    await pollFor(() => store.selectSnapshot(ReportState.status) === expected, `status ${expected}`);
  }

  /** Full mock lead flow: preview → lead → token. */
  async function mockToken(): Promise<string> {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
    const preview = await firstValueFrom(api.getPreviewEstimate({ addressKey: fakeProperty.addressKey, ...baseInputs }));
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
    return token!;
  }

  async function unlock(): Promise<void> {
    const token = await mockToken();
    store.dispatch(new SetReportToken(token));
    store.dispatch(new UnlockReport());
    await pollStatus('ready');
  }

  it('loads the real-figures preview pre-gate (UI blurs them)', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200 })]);
    store.dispatch(new LoadPreview());
    await pollStatus('ready');
    const preview = store.selectSnapshot(ReportState.preview);
    const figures = preview?.figures;
    expect(figures).toBeDefined();
    expect(figures?.build.low).toBeGreaterThan(0);
    expect(figures?.total.high).toBeGreaterThanOrEqual(figures?.total.low ?? 0);
    expect(figures?.land.value).toBeGreaterThanOrEqual(0);
    expect(preview?.rows).toEqual([]);
    expect(store.selectSnapshot(ReportState.unlocked)).toBe(false);
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
  });

  it('fails to load the preview without a property', async () => {
    store.dispatch(new LoadPreview());
    await pollStatus('error');
    expect(store.selectSnapshot(ReportState.error)).toBeTruthy();
  });

  it('unlocks the verified snapshot with a report token', async () => {
    await unlock();
    expect(store.selectSnapshot(ReportState.unlocked)).toBe(true);
    const snapshot = store.selectSnapshot(ReportState.snapshot);
    expect(snapshot?.totalRange.low).toBeLessThan(snapshot!.totalRange.high);
    expect(snapshot?.rows.length).toBeGreaterThan(0);
    expect(snapshot?.version).toBe(1);
  });

  it('fails to unlock with an unknown token', async () => {
    store.dispatch(new SetReportToken('nope'));
    store.dispatch(new UnlockReport());
    await pollStatus('error');
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
  });

  it('reviseReport re-runs the estimate and bumps the version', async () => {
    await unlock();
    const before = store.selectSnapshot(ReportState.snapshot)!;
    store.dispatch(new ReviseReport(undefined, 2300));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2300, 'sqft revision');
    const after = store.selectSnapshot(ReportState.snapshot)!;
    expect(after.inputs.sqft).toBe(2300);
    expect(after.version).toBe(before.version + 1);
    // A bigger home costs more: the build range moves up.
    expect(after.buildRange.base).toBeGreaterThan(before.buildRange.base);
    // Land is the fixed City figure: untouched by the revision.
    expect(after.landValue.value).toBe(before.landValue.value);
  });

  it('a stale revise response never overwrites a newer snapshot', async () => {
    await unlock();

    // Deferred revise API: each call gets its own Subject so the test
    // controls exactly when (and in what order) responses arrive.
    const subjects: Subject<TierRevisionResponse>[] = [];
    const spy = vi
      .spyOn(api, 'reviseTier')
      .mockImplementation((_token: string, _request: TierRevisionRequest) => {
        const subject = new Subject<TierRevisionResponse>();
        subjects.push(subject);
        return subject.asObservable();
      });

    try {
      store.dispatch(new ReviseReport(undefined, 2300));
      store.dispatch(new ReviseReport(undefined, 2400));
      expect(subjects.length).toBe(2);

      const disclaimer = TestBed.inject(ConfigService).get('copy').narrativeDisclaimer;
      const stale: TierRevisionResponse = {
        ...mockReport('estimate-1', 'lead-1', { ...baseInputs, sqft: 2300 }, disclaimer, 2200),
        version: 2,
      };
      const newer: TierRevisionResponse = {
        ...mockReport('estimate-1', 'lead-1', { ...baseInputs, sqft: 2400 }, disclaimer, 2200),
        version: 3,
      };

      // The stale (first) response arrives AFTER the newer dispatch: the
      // cancelled in-flight request must not touch the snapshot. The tap
      // would run synchronously if the subscription were still alive, so a
      // synchronous assertion is exact — no polling.
      subjects[0].next(stale);
      subjects[0].complete();
      expect(store.selectSnapshot(ReportState.snapshot)?.inputs.sqft).toBe(2200);
      expect(store.selectSnapshot(ReportState.status)).toBe('loading');

      // The newer response lands normally.
      subjects[1].next(newer);
      subjects[1].complete();
      await pollFor(
        () => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2400,
        'newer revision',
      );
      expect(store.selectSnapshot(ReportState.status)).toBe('ready');
      expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('reviseReport without a token fails honestly (inline error, not a silent no-op)', async () => {
    store.dispatch(new ReviseReport('luxury'));
    expect(store.selectSnapshot(ReportState.status)).toBe('error');
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
  });

  it('clearReport resets the model', async () => {
    await unlock();
    store.dispatch(new ClearReport());
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
    expect(store.selectSnapshot(ReportState.reportToken)).toBeNull();
    expect(store.selectSnapshot(ReportState.status)).toBe('idle');
  });
});
