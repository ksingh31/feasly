import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminLeadListItem } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  DecideQuarantined,
  DismissQuarantineError,
  LoadMoreQuarantine,
  LoadQuarantine,
  RefreshQuarantineCount,
} from './admin-quarantine.actions';
import { AdminQuarantineState, quarantineFilters } from './admin-quarantine.state';

function lead(id: string): AdminLeadListItem {
  return {
    id,
    name: `Lead ${id}`,
    email: `${id}@example.com`,
    addressKey: '1 Main St NW',
    leadScore: 10,
    status: 'new',
    source: 'mcp',
    projectType: 'new_build',
    tenantKey: 'feasly',
    timeline: '6-12 months',
    sandbox: false,
    quarantined: true,
    discarded: false,
    createdAt: '2026-11-10T10:00:00.000Z',
    contactConsent: 'in',
    consentUpdatedAt: '2026-11-10T10:00:00.000Z',
  };
}

const COUNTS = { new: 0, contacted: 0, quoting: 0, won: 0, lost: 0 };
const list = (leads: AdminLeadListItem[], total = leads.length, cursor: string | null = null) => ({
  leads,
  totalCount: total,
  nextCursor: cursor,
  statusCounts: COUNTS,
});

const isList = (r: { url: string }) => r.url.endsWith('/api/v1/admin/leads');
const decisionUrl = (id: string, d: 'approve' | 'discard') => (r: { url: string; method: string }) =>
  r.url.endsWith(`/api/v1/admin/leads/${id}/quarantine/${d}`) && r.method === 'POST';

/** #540 — the Quarantine queue store (own route, bulk decisions). */
describe('AdminQuarantineState', () => {
  let store: Store;
  let http: HttpTestingController;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ConfigService, provideStore([AdminQuarantineState])],
    });
    http = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    http
      .expectOne('/assets/config/app-config.json')
      .flush({ api: { useMockApi: false }, admin: { quarantine: { bulkConcurrency: 2 } } });
    await pending;
    store = TestBed.inject(Store);
  });

  async function seed(leads: AdminLeadListItem[], total = leads.length): Promise<void> {
    const done = firstValueFrom(store.dispatch(new LoadQuarantine()), { defaultValue: undefined });
    http.expectOne(isList).flush(list(leads, total));
    await done;
  }

  it('lists only honeypot-flagged rows and sets the badge count from an unsearched load', async () => {
    const done = firstValueFrom(store.dispatch(new LoadQuarantine()), { defaultValue: undefined });
    const req = http.expectOne(isList);
    expect(req.request.params.get('quarantinedOnly')).toBe('true');
    expect(req.request.params.get('includeQuarantined')).toBe('true');
    expect(req.request.params.get('search')).toBeNull();
    req.flush(list([lead('a'), lead('b')], 2));
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.leads).map((l) => l.id)).toEqual(['a', 'b']);
    expect(store.selectSnapshot(AdminQuarantineState.queueCount)).toBe(2);
  });

  it('a searched load narrows the list but leaves the badge count alone', async () => {
    await seed([lead('a'), lead('b')], 2);
    const done = firstValueFrom(store.dispatch(new LoadQuarantine('  ava ')), { defaultValue: undefined });
    const req = http.expectOne(isList);
    expect(req.request.params.get('search')).toBe('ava');
    req.flush(list([lead('a')], 1));
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.totalCount)).toBe(1);
    expect(store.selectSnapshot(AdminQuarantineState.queueCount)).toBe(2);
  });

  it('refreshes just the badge count with a one-row request', async () => {
    const done = firstValueFrom(store.dispatch(new RefreshQuarantineCount()), { defaultValue: undefined });
    const req = http.expectOne(isList);
    expect(req.request.params.get('limit')).toBe('1');
    expect(req.request.params.get('quarantinedOnly')).toBe('true');
    req.flush(list([lead('a')], 7));
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.queueCount)).toBe(7);
    expect(store.selectSnapshot(AdminQuarantineState.leads)).toEqual([]);
  });

  it('surfaces a load failure as an error state', async () => {
    const done = firstValueFrom(store.dispatch(new LoadQuarantine()), { defaultValue: undefined });
    http.expectOne(isList).flush('nope', { status: 500, statusText: 'Server Error' });
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.listStatus)).toBe('error');
    expect(store.selectSnapshot(AdminQuarantineState.listError)).toBeTruthy();
  });

  it('appends the next page on load more', async () => {
    const first = firstValueFrom(store.dispatch(new LoadQuarantine()), { defaultValue: undefined });
    http.expectOne(isList).flush(list([lead('a')], 2, 'c1'));
    await first;
    const more = firstValueFrom(store.dispatch(new LoadMoreQuarantine()), { defaultValue: undefined });
    const req = http.expectOne(isList);
    expect(req.request.params.get('cursor')).toBe('c1');
    req.flush(list([lead('b')], 2));
    await more;
    expect(store.selectSnapshot(AdminQuarantineState.leads).map((l) => l.id)).toEqual(['a', 'b']);
    expect(store.selectSnapshot(AdminQuarantineState.hasMore)).toBe(false);
  });

  it('bulk approve posts once per lead and removes every approved lead', async () => {
    await seed([lead('a'), lead('b'), lead('c')]);
    const done = firstValueFrom(store.dispatch(new DecideQuarantined(['a', 'b'], 'approve')), {
      defaultValue: undefined,
    });
    expect(store.selectSnapshot(AdminQuarantineState.busyIds)).toEqual(['a', 'b']);
    expect(store.selectSnapshot(AdminQuarantineState.busyDecision)).toBe('approve');
    http.expectOne(decisionUrl('a', 'approve')).flush({ ok: true });
    http.expectOne(decisionUrl('b', 'approve')).flush({ ok: true });
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.leads).map((l) => l.id)).toEqual(['c']);
    expect(store.selectSnapshot(AdminQuarantineState.totalCount)).toBe(1);
    expect(store.selectSnapshot(AdminQuarantineState.queueCount)).toBe(1);
    expect(store.selectSnapshot(AdminQuarantineState.busyIds)).toEqual([]);
    expect(store.selectSnapshot(AdminQuarantineState.actionError)).toBeNull();
    expect(store.selectSnapshot(AdminQuarantineState.lastResult)).toEqual({
      decision: 'approve',
      requested: 2,
      succeeded: ['a', 'b'],
      failed: [],
    });
  });

  it('caps parallel calls at the configured concurrency', async () => {
    await seed([lead('a'), lead('b'), lead('c')]);
    const done = firstValueFrom(store.dispatch(new DecideQuarantined(['a', 'b', 'c'], 'discard')), {
      defaultValue: undefined,
    });
    const inFlight = (): TestRequest[] => http.match((r) => r.url.includes('/quarantine/discard'));
    const firstWave = inFlight();
    expect(firstWave).toHaveLength(2);
    firstWave.forEach((r) => r.flush({ ok: true }));
    const secondWave = inFlight();
    expect(secondWave).toHaveLength(1);
    secondWave[0].flush({ ok: true });
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.leads)).toEqual([]);
  });

  it('keeps failed leads in the queue and reports a partial failure', async () => {
    await seed([lead('a'), lead('b'), lead('c')]);
    const done = firstValueFrom(store.dispatch(new DecideQuarantined(['a', 'b', 'c'], 'discard')), {
      defaultValue: undefined,
    });
    http.expectOne(decisionUrl('a', 'discard')).flush({ ok: true });
    http.expectOne(decisionUrl('b', 'discard')).flush('Unprocessable', { status: 422, statusText: 'Unprocessable' });
    http.expectOne(decisionUrl('c', 'discard')).flush({ ok: true });
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.leads).map((l) => l.id)).toEqual(['b']);
    expect(store.selectSnapshot(AdminQuarantineState.actionError)).toBe(
      '1 of 3 leads could not be updated and are still selected. Please try again.',
    );
    expect(store.selectSnapshot(AdminQuarantineState.lastResult)?.failed).toEqual(['b']);

    store.dispatch(new DismissQuarantineError());
    expect(store.selectSnapshot(AdminQuarantineState.actionError)).toBeNull();
  });

  it('uses the single-lead message when one row action fails', async () => {
    await seed([lead('a')]);
    const done = firstValueFrom(store.dispatch(new DecideQuarantined(['a'], 'approve')), { defaultValue: undefined });
    http.expectOne(decisionUrl('a', 'approve')).flush('Forbidden', { status: 403, statusText: 'Forbidden' });
    await done;
    expect(store.selectSnapshot(AdminQuarantineState.leads)).toHaveLength(1);
    expect(store.selectSnapshot(AdminQuarantineState.actionError)).toBe('Could not update the lead. Please try again.');
  });

  it('ignores a second decision while one is in flight', async () => {
    await seed([lead('a'), lead('b')]);
    const first = firstValueFrom(store.dispatch(new DecideQuarantined(['a'], 'approve')), { defaultValue: undefined });
    store.dispatch(new DecideQuarantined(['b'], 'discard'));
    http.expectNone(decisionUrl('b', 'discard'));
    http.expectOne(decisionUrl('a', 'approve')).flush({ ok: true });
    await first;
    expect(store.selectSnapshot(AdminQuarantineState.leads).map((l) => l.id)).toEqual(['b']);
  });

  it('builds queue filters with an optional trimmed search', () => {
    expect(quarantineFilters('')).toEqual({ includeQuarantined: true, quarantinedOnly: true });
    expect(quarantineFilters(' x ')).toEqual({ includeQuarantined: true, quarantinedOnly: true, search: 'x' });
  });
});
