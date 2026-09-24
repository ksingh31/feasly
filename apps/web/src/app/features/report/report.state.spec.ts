import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import type { PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { ConfigService } from '../../core/config/config.service';
import { SelectProperty, UpdateInputs, WizardState } from '../wizard';
import { ClearReport, LoadPreview, ReviseReport, SetReportToken, UnlockReport } from './report.actions';
import { ReportState } from './report.state';

/**
 * M1: ReportState holds the blurred preview pre-gate and the verified
 * snapshot post-gate; the component never touches the API directly.
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

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideStore([WizardState, ReportState])],
    });
    // provideApi is a factory provider; register it explicitly.
    TestBed.configureTestingModule({ providers: [{ provide: API_SERVICE, useClass: MockApiService }] });
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
    const preview = await firstValueFrom(
      api.getPreviewEstimate({ addressKey: fakeProperty.addressKey, sqft: 2200, tier: 'premium', garage: 'double', basement: 'unfinished' }),
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
    const token = api.devMagicLinkForLead(lead.leadId);
    expect(token).toBeTruthy();
    return token!;
  }

  it('loads the blurred preview pre-gate', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200 })]);
    store.dispatch(new LoadPreview());
    await pollStatus('ready');
    const preview = store.selectSnapshot(ReportState.preview);
    expect(preview?.figures.build).toEqual({ blurred: true });
    expect(preview?.figures.total).toEqual({ blurred: true });
    expect(preview?.figures.land).toEqual({ blurred: true });
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
    const token = await mockToken();
    store.dispatch(new SetReportToken(token));
    store.dispatch(new UnlockReport());
    await pollStatus('ready');
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

  it('reviseTier re-runs the estimate and bumps the version', async () => {
    const token = await mockToken();
    store.dispatch(new SetReportToken(token));
    store.dispatch(new UnlockReport());
    await pollStatus('ready');
    const before = store.selectSnapshot(ReportState.snapshot)!;
    store.dispatch(new ReviseReport('luxury'));
    await pollFor(
      () => store.selectSnapshot(ReportState.snapshot)?.inputs.tier === 'luxury',
      'tier revision',
    );
    const after = store.selectSnapshot(ReportState.snapshot)!;
    expect(after.inputs.tier).toBe('luxury');
    expect(after.version).toBe(before.version + 1);
    // Luxury costs more than premium: figures move up.
    expect(after.totalRange.low).toBeGreaterThan(before.totalRange.low);
  });

  it('reviseTier without a token is a no-op', async () => {
    store.dispatch(new ReviseReport('luxury'));
    expect(store.selectSnapshot(ReportState.status)).toBe('idle');
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
  });

  it('clearReport resets the model', async () => {
    const token = await mockToken();
    store.dispatch(new SetReportToken(token));
    store.dispatch(new UnlockReport());
    await pollStatus('ready');
    store.dispatch(new ClearReport());
    expect(store.selectSnapshot(ReportState.snapshot)).toBeNull();
    expect(store.selectSnapshot(ReportState.reportToken)).toBeNull();
    expect(store.selectSnapshot(ReportState.status)).toBe('idle');
  });
});
