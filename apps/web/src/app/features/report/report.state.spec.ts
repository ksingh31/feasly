import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import type { PropertyRecord, TierRevisionRequest, TierRevisionResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { buildNewBuildRequest } from '../../core/api/build-estimate-request';
import { MockApiService } from '../../core/api/mock-api.service';
import { mockPreviewEstimate, mockReport } from '../../core/api/mock-data';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { LeadState, SelectProperty, StoreLeadResult, UpdateInputs, WizardState } from '../wizard';
import {
  ClearReport,
  LoadLeadEstimate,
  LoadPreview,
  ReviseReport,
  SetPartnerView,
  SetReportToken,
  UnlockReport,
} from './report.actions';
import { ReportState, serializeReportState } from './report.state';
import type { ReportStateModel } from './report.state';

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
      providers: [provideHttpClient(), provideHttpClientTesting(), provideStore([WizardState, LeadState, ReportState])],
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
    const preview = await firstValueFrom(api.getPreviewEstimate(buildNewBuildRequest(fakeProperty, baseInputs)));
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

  it('classifies a non-retryable API failure as a validation error with detail', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200 })]);
    vi.spyOn(api, 'getPreviewEstimate').mockReturnValue(
      throwError(() => ({
        code: 'VALIDATION_FAILED',
        message: 'lotSizeSqft 643811 outside [1200, 20000]',
        retryable: false,
      })),
    );
    store.dispatch(new LoadPreview());
    await pollStatus('error');
    expect(store.selectSnapshot(ReportState.error)).toBe('validation');
    expect(store.selectSnapshot(ReportState.errorDetail)).toBe('lotSizeSqft 643811 outside [1200, 20000]');
  });

  it('classifies a retryable API failure as a generic load error', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200 })]);
    vi.spyOn(api, 'getPreviewEstimate').mockReturnValue(
      throwError(() => ({
        code: 'http_500',
        message: 'Request failed. Please try again.',
        retryable: true,
      })),
    );
    store.dispatch(new LoadPreview());
    await pollStatus('error');
    expect(store.selectSnapshot(ReportState.error)).toBe('load');
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

  it('SetPartnerView marks the session read-only; a fresh SetReportToken resets it', () => {
    // Default is owner view.
    expect(store.selectSnapshot(ReportState.partnerView)).toBe(false);
    store.dispatch(new SetPartnerView());
    expect(store.selectSnapshot(ReportState.partnerView)).toBe(true);
    // A fresh owner link (from the owner verify path) resets partner mode.
    store.dispatch(new SetReportToken('owner-tok'));
    expect(store.selectSnapshot(ReportState.partnerView)).toBe(false);
    expect(store.selectSnapshot(ReportState.reportToken)).toBe('owner-tok');
  });

  it('top-ups an empty snapshot narrative via getNarrative', async () => {
    const token = await mockToken();
    const emptyNarrative: TierRevisionResponse = {
      ...mockReport('estimate-1', 'lead-1', { ...baseInputs }, 'disclaimer'),
      version: 1,
      narrative: '   ',
    };
    const reportSpy = vi.spyOn(api, 'getReport').mockImplementation(() => of(emptyNarrative));
    const narrativeSpy = vi.spyOn(api, 'getNarrative').mockImplementation(() =>
      of({
        estimateId: 'estimate-1',
        narrative: 'Fresh narrative from the backend.',
        narrativeGeneratedAt: new Date().toISOString(),
        cached: false,
        narrativeSource: 'ai',
      }),
    );
    try {
      store.dispatch(new SetReportToken(token));
      store.dispatch(new UnlockReport());
      await pollStatus('ready');
      expect(narrativeSpy).toHaveBeenCalledWith('estimate-1', token);
      expect(store.selectSnapshot(ReportState.snapshot)?.narrative).toBe(
        'Fresh narrative from the backend.',
      );
    } finally {
      reportSpy.mockRestore();
      narrativeSpy.mockRestore();
    }
  });

  it('keeps the snapshot (honest empty narrative) when the narrative fetch fails', async () => {
    const token = await mockToken();
    const emptyNarrative: TierRevisionResponse = {
      ...mockReport('estimate-1', 'lead-1', { ...baseInputs }, 'disclaimer'),
      version: 1,
      narrative: '',
    };
    const reportSpy = vi.spyOn(api, 'getReport').mockImplementation(() => of(emptyNarrative));
    const narrativeSpy = vi
      .spyOn(api, 'getNarrative')
      .mockImplementation(() => throwError(() => new Error('narrative down')));
    try {
      store.dispatch(new SetReportToken(token));
      store.dispatch(new UnlockReport());
      await pollStatus('ready');
      const snapshot = store.selectSnapshot(ReportState.snapshot);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.narrative).toBe('');
    } finally {
      reportSpy.mockRestore();
      narrativeSpy.mockRestore();
    }
  });

  it('skips the narrative fetch when the snapshot already has one', async () => {
    const narrativeSpy = vi.spyOn(api, 'getNarrative');
    try {
      await unlock();
      expect(store.selectSnapshot(ReportState.snapshot)?.narrative).toBeTruthy();
      expect(narrativeSpy).not.toHaveBeenCalled();
    } finally {
      narrativeSpy.mockRestore();
    }
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

  it('LoadLeadEstimate starts the first report at version 1', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-1',
        email: 'buyer@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('ready');
    expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(1);
  });

  it('a reload keeps the persisted revision version instead of resetting to 1', async () => {
    // Reach v3 through two stepper revisions on the token path (the
    // component updates the wizard inputs before each revise).
    await unlock();
    store.dispatch(new UpdateInputs({ sqft: 2300 }));
    store.dispatch(new ReviseReport(undefined, 2300));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2300, 'revision 1');
    store.dispatch(new UpdateInputs({ sqft: 2400 }));
    store.dispatch(new ReviseReport(undefined, 2400));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2400, 'revision 2');
    expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(3);

    // Simulate a reload: the storage plugin strips the session-scoped
    // snapshot and token but keeps the persisted revision counter
    // (savedVersion) alongside the wizard inputs — and the submitted lead
    // persists too, which is what lets the report rebuild at all.
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-1',
        email: 'buyer@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new SetReportToken(''));
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
    expect(store.selectSnapshot(ReportState.reportToken)).toBeFalsy();

    // Rebuilding from the persisted wizard inputs must keep v3, not restart
    // at 1 — the figures match the pre-reload ones.
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('ready');
    const rebuilt = store.selectSnapshot(ReportState.snapshot)!;
    expect(rebuilt.version).toBe(3);
    expect(rebuilt.inputs.sqft).toBe(2400);
  });

  it('a revision after a reload continues the sequence (v3 -> v4)', async () => {
    await unlock();
    store.dispatch(new UpdateInputs({ sqft: 2300 }));
    store.dispatch(new ReviseReport(undefined, 2300));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2300, 'revision 1');
    store.dispatch(new UpdateInputs({ sqft: 2400 }));
    store.dispatch(new ReviseReport(undefined, 2400));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2400, 'revision 2');
    expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(3);

    // Reload: the lead persists (it is stored), the session-scoped token
    // does not — and the next revision must continue the sequence.
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-1',
        email: 'buyer@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new SetReportToken(''));
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('ready');
    expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(3);

    // …then one more revision on the lead path becomes v4, not v2.
    store.dispatch(new UpdateInputs({ sqft: 2500 }));
    store.dispatch(new ReviseReport(undefined, 2500));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2500, 'post-reload revision');
    expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(4);
  });

  it('a token-path snapshot takes the backend version and persists it across reloads', async () => {
    await unlock();
    const token = store.selectSnapshot(ReportState.reportToken)!;
    // The backend owns append-only versions: a v7 snapshot arriving over the
    // token lands as v7 (not "current + 1").
    const v7: TierRevisionResponse = {
      ...mockReport('estimate-1', 'lead-1', { ...baseInputs }, 'disclaimer'),
      version: 7,
      narrative: 'n',
    };
    const spy = vi.spyOn(api, 'getReport').mockImplementation(() => of(v7));
    try {
      store.dispatch(new UnlockReport());
      await pollStatus('ready');
      expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(7);
    } finally {
      spy.mockRestore();
    }
    // Reload: the lead persists (it is stored), the session-scoped token
    // does not — the rebuilt lead-estimate report keeps v7.
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-1',
        email: 'buyer@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new SetReportToken(''));
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('ready');
    expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(7);
    expect(token).toBeTruthy();
  });

  it('clearReport resets the revision counter for a genuinely new property', async () => {
    await unlock();
    store.dispatch(new UpdateInputs({ sqft: 2300 }));
    store.dispatch(new ReviseReport(undefined, 2300));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2300, 'revision 1');
    store.dispatch(new ClearReport());
    // A new property's first report starts at version 1 again.
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-2',
        email: 'buyer@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('ready');
    expect(store.selectSnapshot(ReportState.snapshot)?.version).toBe(1);
  });

  it('LoadLeadEstimate unlocks the report from a submitted lead (Karan directive 2026-09-27)', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-1',
        email: 'buyer@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('ready');
    expect(store.selectSnapshot(ReportState.unlocked)).toBe(true);
    const report = store.selectSnapshot(ReportState.snapshot);
    expect(report).not.toBeNull();
    // Real figures from the public full-estimate endpoint.
    expect(report!.totalRange.base).toBeGreaterThan(0);
    expect(report!.rows.length).toBeGreaterThan(0);
    // No token exists in this state, so no narrative was fetched — the
    // component shows the honest empty state instead of inventing one.
    expect(store.selectSnapshot(ReportState.reportToken)).toBeNull();
    expect(report!.narrative).toBe('');
  });

  it('LoadLeadEstimate without a submitted lead fails honestly', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200 })]);
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('error');
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
    expect(store.selectSnapshot(ReportState.unlocked)).toBe(false);
  });

  it('reviseReport without a token but with a submitted lead re-runs the public estimate', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-1',
        email: 'buyer@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new LoadLeadEstimate());
    await pollStatus('ready');
    const before = store.selectSnapshot(ReportState.snapshot)!;
    store.dispatch(new ReviseReport(undefined, 2300));
    await pollFor(() => store.selectSnapshot(ReportState.snapshot)?.inputs.sqft === 2300, 'lead sqft revision');
    const after = store.selectSnapshot(ReportState.snapshot)!;
    expect(after.inputs.sqft).toBe(2300);
    expect(after.version).toBe(before.version + 1);
    // A bigger home costs more: the build range moves up.
    expect(after.buildRange.base).toBeGreaterThan(before.buildRange.base);
  });

  it('clearReport resets the model', async () => {
    await unlock();
    store.dispatch(new ClearReport());
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
    expect(store.selectSnapshot(ReportState.reportToken)).toBeNull();
    expect(store.selectSnapshot(ReportState.status)).toBe('idle');
  });

  describe('AI narrative persistence (ai-summary-persistence)', () => {
    /** A model with everything set, exactly as the live state can hold it. */
    function fullModel(): ReportStateModel {
      return {
        preview: mockPreviewEstimate('calgary-918-16-ave-nw', { ...baseInputs }),
        reportToken: 'tok-123',
        partnerView: true,
        snapshot: {
          ...mockReport('estimate-1', 'lead-1', { ...baseInputs }, 'disclaimer'),
          narrative: 'Persisted neighbourhood guide.',
          narrativeSource: 'ai',
          version: 3,
        },
        savedVersion: 3,
        status: 'loading',
        error: 'boom',
        errorDetail: 'detail',
      };
    }

    it('serializeReportState keeps the snapshot (figures + narrative) and strips session state', () => {
      const model = fullModel();
      const snapshot = model.snapshot!;
      const out = serializeReportState(model);
      // The user's own figures AND the AI narrative survive a reload.
      expect(out.snapshot).toBe(snapshot);
      expect(out.snapshot?.narrative).toBe('Persisted neighbourhood guide.');
      expect(out.snapshot?.narrativeSource).toBe('ai');
      expect(out.savedVersion).toBe(3);
      // Memory-only and session-scoped state never reaches localStorage.
      expect(out.reportToken).toBeNull();
      expect(out.partnerView).toBe(false);
      expect(out.preview).toBeNull();
      expect(out.error).toBeNull();
      expect(out.errorDetail).toBeNull();
      expect(out.status).toBe('ready');
    });

    it('serializeReportState settles to idle when there is no snapshot to restore', () => {
      const out = serializeReportState({ ...fullModel(), snapshot: null, savedVersion: 0 });
      expect(out.snapshot).toBeNull();
      expect(out.status).toBe('idle');
      expect(out.reportToken).toBeNull();
    });

    it('LoadLeadEstimate carries the existing narrative forward for the same lead (a retry keeps the guide)', async () => {
      store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
      store.dispatch(
        new StoreLeadResult({
          leadId: 'lead-1',
          email: 'buyer@example.com',
          magicLinkSent: true,
          expiresInDays: 7,
        }),
      );
      // The guide landed before the reload (token path); rebuilding the
      // snapshot from the public endpoint must not drop it.
      const withGuide = {
        ...mockReport('estimate-1', 'lead-1', { ...baseInputs }, 'disclaimer'),
        narrative: 'Persisted neighbourhood guide.',
        narrativeSource: 'ai' as const,
        version: 2,
      };
      store.reset({
        ...store.snapshot(),
        report: { ...store.snapshot().report, snapshot: withGuide, savedVersion: 2 },
      });
      store.dispatch(new LoadLeadEstimate());
      await pollStatus('ready');
      const rebuilt = store.selectSnapshot(ReportState.snapshot)!;
      expect(rebuilt.leadId).toBe('lead-1');
      expect(rebuilt.narrative).toBe('Persisted neighbourhood guide.');
      expect(rebuilt.narrativeSource).toBe('ai');
      // The figures are rebuilt from the public estimate, not stale copies.
      expect(rebuilt.totalRange.base).toBeGreaterThan(0);
    });

    it('a snapshot rebuilt for a different lead never inherits the narrative', async () => {
      store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
      const otherLeadsGuide = {
        ...mockReport('estimate-1', 'lead-1', { ...baseInputs }, 'disclaimer'),
        narrative: 'Another lead\u2019s guide.',
        narrativeSource: 'ai' as const,
        version: 2,
      };
      store.reset({
        ...store.snapshot(),
        report: { ...store.snapshot().report, snapshot: otherLeadsGuide, savedVersion: 2 },
      });
      // A genuinely new lead: the old guide must not leak onto it.
      store.dispatch(
        new StoreLeadResult({
          leadId: 'lead-2',
          email: 'buyer@example.com',
          magicLinkSent: true,
          expiresInDays: 7,
        }),
      );
      store.dispatch(new LoadLeadEstimate());
      await pollStatus('ready');
      const rebuilt = store.selectSnapshot(ReportState.snapshot)!;
      expect(rebuilt.leadId).toBe('lead-2');
      expect(rebuilt.narrative).toBe('');
    });
  });
});
