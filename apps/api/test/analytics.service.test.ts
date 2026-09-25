/**
 * Analytics ingest service tests (story consumer/01).
 *
 * Covers the consent-gate matrix (missing consent_ts → CONSENT_REQUIRED,
 * future-dated consent_ts → CONSENT_REQUIRED, skew allowance respected),
 * the event allowlist (arbitrary names → 400), the closed payload shape
 * (unknown keys rejected — no PII can be smuggled in), and the happy path
 * returning the contract-shaped stored event.
 *
 * The store is faked at the interface boundary; the real Drizzle store is
 * covered against PGlite in analytics.stores.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENT_ALLOWLIST,
  CONSENT_SKEW_ALLOWANCE_MS,
  createAnalyticsService,
} from '../src/services/analytics.service';
import type {
  AnalyticsEventRecord,
  AnalyticsStore,
  NewAnalyticsEvent,
} from '../src/services/analytics.store';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const NOW = new Date('2026-09-25T12:00:00Z');

function fakeStore(): AnalyticsStore & { inserted: NewAnalyticsEvent[] } {
  const inserted: NewAnalyticsEvent[] = [];
  return {
    inserted,
    insert: async (event: NewAnalyticsEvent): Promise<AnalyticsEventRecord> => {
      inserted.push(event);
      return { ...event, createdAt: NOW };
    },
  };
}

const validBody = () => ({
  event: 'step_view',
  route: '/estimate/scope',
  ts: '2026-09-25T12:00:00.000Z',
  consent_ts: '2026-09-25T11:59:00.000Z',
});

describe('analytics service', () => {
  it('ingests a valid event and returns the contract shape', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const result = await service.ingestEvent(validBody());
    expect(result).toEqual({
      event: 'step_view',
      route: '/estimate/scope',
      ts: '2026-09-25T12:00:00.000Z',
      consent_ts: '2026-09-25T11:59:00.000Z',
    });
    expect(store.inserted).toHaveLength(1);
  });

  it('rejects a missing consent_ts with CONSENT_REQUIRED', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const { consent_ts: _dropped, ...body } = validBody();
    const error = await service.ingestEvent(body).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe(ErrorCodes.CONSENT_REQUIRED);
    expect(store.inserted).toHaveLength(0);
  });

  it('rejects a future-dated consent_ts with CONSENT_REQUIRED', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const error = await service
      .ingestEvent({
        ...validBody(),
        consent_ts: '2026-09-25T13:00:00.000Z',
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe(ErrorCodes.CONSENT_REQUIRED);
    expect(store.inserted).toHaveLength(0);
  });

  it('tolerates consent_ts within the clock-skew allowance', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const skewTs = new Date(NOW.getTime() + CONSENT_SKEW_ALLOWANCE_MS - 1000);
    const result = await service.ingestEvent({
      ...validBody(),
      consent_ts: skewTs.toISOString(),
    });
    expect(result.event).toBe('step_view');
    expect(store.inserted).toHaveLength(1);
  });

  it('rejects an event outside the allowlist', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const error = await service
      .ingestEvent({ ...validBody(), event: 'custom_arbitrary_event' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(store.inserted).toHaveLength(0);
  });

  it('accepts every allowlisted event name', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    for (const event of ANALYTICS_EVENT_ALLOWLIST) {
      const result = await service.ingestEvent({ ...validBody(), event });
      expect(result.event).toBe(event);
    }
    expect(store.inserted).toHaveLength(ANALYTICS_EVENT_ALLOWLIST.length);
  });

  it('rejects unknown payload keys (closed shape — no PII smuggling)', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const error = await service
      .ingestEvent({ ...validBody(), email: 'sam@example.com' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(store.inserted).toHaveLength(0);
  });

  it('never echoes submitted values in error messages', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const error = await service
      .ingestEvent({ ...validBody(), route: '' })
      .catch((e) => e);
    expect(error.message).not.toContain('sam@example.com');
  });
});
