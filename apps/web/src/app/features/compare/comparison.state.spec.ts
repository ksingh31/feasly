import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_SERVICE } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { UpdateComparison, WizardState } from '../wizard';
import {
  ClearComparisonResult,
  ComparisonLeadSubmitted,
  ReviseComparisonTier,
  RunComparison,
} from './comparison.actions';
import { ComparisonState } from './comparison.state';

/**
 * ComparisonState (NBH-03): runs the stats → estimate pipeline, holds the
 * result + stats, and tracks the lead-gate unlock. Components never call the
 * API directly.
 */
describe('ComparisonState', () => {
  let store: Store;

  const baseConfig = {
    api: { useMockApi: true },
    timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
    wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
  };

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([WizardState, ComparisonState]),
      ],
    });
    TestBed.configureTestingModule({
      providers: [
        providePropertyData(),
        { provide: API_SERVICE, useClass: MockApiService },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    store = TestBed.inject(Store);
    store.dispatch(new UpdateComparison({ slugs: ['beltline', 'panorama-hills'], sqft: 2200, tier: 'premium' }));
  }

  beforeEach(async () => {
    await setup();
  });

  /** Polls until the predicate holds — never a fixed sleep. */
  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5000,
  ): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('runs the pipeline: stats + estimate populate the state', async () => {
    store.dispatch(new RunComparison());
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'ready');

    const result = store.selectSnapshot(ComparisonState.result);
    expect(result).not.toBeNull();
    expect(result?.rowSets).toHaveLength(2);
    expect(result?.inputs).toEqual({ sqft: 2200, tier: 'premium' });

    const stats = store.selectSnapshot(ComparisonState.stats);
    expect(stats['beltline']?.avg_assessed_value).toBe(607351);
    expect(stats['panorama-hills']?.avg_assessed_value).toBe(596377);

    // Exactly one lowest-land flag from the API.
    expect(result?.rowSets.filter((r) => r.lowestLand)).toHaveLength(1);
  });

  it('exposes the pipeline stage while loading', async () => {
    store.dispatch(new RunComparison());
    // The stage is set synchronously on dispatch (validating → fetching on
    // subscribe), progresses through calculating, and clears on completion.
    const seen = new Set<string | null>();
    seen.add(store.selectSnapshot(ComparisonState.stage));
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'ready');
    seen.add(store.selectSnapshot(ComparisonState.stage));
    // While loading the stage was a real pipeline stage (not null); after
    // completion it clears.
    expect(seen.has('validating') || seen.has('fetching') || seen.has('calculating')).toBe(true);
    expect(store.selectSnapshot(ComparisonState.stage)).toBeNull();
  });

  it('fails honestly when a community slug is unknown', async () => {
    store.dispatch(new UpdateComparison({ slugs: ['beltline', 'no-such-community'] }));
    store.dispatch(new RunComparison());
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'error');
    expect(store.selectSnapshot(ComparisonState.result)).toBeNull();
  });

  it('re-runs every row-set on tier revision (what-if)', async () => {
    store.dispatch(new RunComparison());
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'ready');
    const before = store.selectSnapshot(ComparisonState.result)?.rowSets[0].build.base;

    store.dispatch(new ReviseComparisonTier('luxury'));
    await waitFor(
      () =>
        store.selectSnapshot(ComparisonState.status) === 'ready' &&
        store.selectSnapshot(ComparisonState.result)?.inputs.tier === 'luxury',
    );
    const after = store.selectSnapshot(ComparisonState.result)?.rowSets[0].build.base;
    expect(after).toBeGreaterThan(before ?? 0);
    // The wizard's persisted tier follows the revision.
    expect(store.selectSnapshot(WizardState.comparison).tier).toBe('luxury');
  });

  it('unlocks on lead submission (ComparisonLeadSubmitted)', async () => {
    expect(store.selectSnapshot(ComparisonState.unlocked)).toBe(false);
    store.dispatch(new ComparisonLeadSubmitted('lead-mock-123'));
    expect(store.selectSnapshot(ComparisonState.unlocked)).toBe(true);
    expect(store.selectSnapshot(ComparisonState.leadId)).toBe('lead-mock-123');
  });

  it('clears the result on ClearComparisonResult', async () => {
    store.dispatch(new RunComparison());
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'ready');
    store.dispatch(new ClearComparisonResult());
    expect(store.selectSnapshot(ComparisonState.result)).toBeNull();
    expect(store.selectSnapshot(ComparisonState.status)).toBe('idle');
  });
});
