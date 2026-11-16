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

  it('stores tenant_key when provided (admin/07 embed attribution)', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    await service.ingestEvent({ ...validBody(), tenant_key: 'acme-builders' });
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.tenantKey).toBe('acme-builders');
  });

  it('stores null tenant_key when omitted (Feasly-direct)', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    await service.ingestEvent(validBody());
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.tenantKey).toBeNull();
  });

  describe('campaign source (#814)', () => {
    const source = {
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring-infill',
      utm_term: 'infill builder calgary',
      utm_content: 'ad-a',
      click_id_type: 'gclid',
    };

    it('stores the source and echoes it in the contract shape', async () => {
      const store = fakeStore();
      const service = createAnalyticsService({ store, clock: () => NOW });
      const result = await service.ingestEvent({
        ...validBody(),
        event: 'landing_view',
        route: '/',
        source,
      });
      expect(result.source).toEqual(source);
      expect(store.inserted[0]!.source).toEqual({
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'spring-infill',
        utmTerm: 'infill builder calgary',
        utmContent: 'ad-a',
        clickIdType: 'gclid',
      });
    });

    it('stores all-null source columns when source is omitted', async () => {
      const store = fakeStore();
      const service = createAnalyticsService({ store, clock: () => NOW });
      const result = await service.ingestEvent(validBody());
      expect(result).not.toHaveProperty('source');
      expect(Object.values(store.inserted[0]!.source).every((v) => v === null)).toBe(
        true,
      );
    });

    it.each([
      ['an unknown source key (click id value)', { gclid: 'abc123' }],
      ['an email in a utm value', { utm_term: 'jane@example.com' }],
      ['a dollar figure in a utm value', { utm_content: '$450,000' }],
      ['a raw query-string fragment', { utm_source: 'google&email=x' }],
      ['an over-length value', { utm_campaign: 'x'.repeat(101) }],
      ['an unknown click_id_type', { click_id_type: 'ttclid' }],
      ['a non-string value', { utm_source: 42 }],
    ])('rejects %s with VALIDATION_FAILED', async (_label, bad) => {
      const store = fakeStore();
      const service = createAnalyticsService({ store, clock: () => NOW });
      const error = await service
        .ingestEvent({ ...validBody(), source: { utm_source: 'google', ...bad } })
        .catch((e) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      // Field path only — the submitted value is never echoed.
      expect(error.message).toMatch(/^Invalid analytics event at 'source/);
      expect(error.message).not.toContain('example.com');
      expect(error.message).not.toContain('450');
      expect(store.inserted).toHaveLength(0);
    });

    it('accepts every new #814 event name', async () => {
      const store = fakeStore();
      const service = createAnalyticsService({ store, clock: () => NOW });
      for (const event of [
        'landing_view',
        'address_search',
        'address_selected',
        'address_no_results',
        'out_of_coverage',
        'property_unsupported',
        'preview_view',
        'estimate_error',
        'magic_link_open',
        'assessment_view',
        'assessment_to_estimate',
      ]) {
        await expect(
          service.ingestEvent({ ...validBody(), event }),
        ).resolves.toMatchObject({ event });
      }
    });
  });
});

describe('analytics service — embed_origin (#870)', () => {
  const embedBody = (extra: Record<string, unknown> = {}) => ({
    event: 'embed_loaded',
    route: '/embed/builder-a',
    ts: '2026-09-25T12:00:00.000Z',
    consent_ts: '2026-09-25T11:59:00.000Z',
    tenant_key: 'builder-a',
    ...extra,
  });

  it('stores the canonical origin on embed_loaded with a tenant key', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    await service.ingestEvent(embedBody({ embed_origin: 'https://WWW.Builder-A.example/' }));
    expect(store.inserted[0]?.embedOrigin).toBe('https://www.builder-a.example');
  });

  it('stores null when omitted (old clients keep working)', async () => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    await service.ingestEvent(embedBody());
    expect(store.inserted[0]?.embedOrigin).toBeNull();
  });

  it.each([
    ['a page URL', embedBody({ embed_origin: 'https://www.builder-a.example/contact?email=x' })],
    ['plain http', embedBody({ embed_origin: 'http://www.builder-a.example' })],
    ['another event', { ...embedBody({ embed_origin: 'https://www.builder-a.example' }), event: 'step_view' }],
    ['no tenant key', (() => { const b: Record<string, unknown> = embedBody({ embed_origin: 'https://www.builder-a.example' }); delete b['tenant_key']; return b; })()],
  ])('rejects %s with a 400 at embed_origin', async (_label, body) => {
    const store = fakeStore();
    const service = createAnalyticsService({ store, clock: () => NOW });
    const error = await service.ingestEvent(body).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toContain('embed_origin');
    expect((error as HttpError).message).not.toContain('email=x');
    expect(store.inserted).toHaveLength(0);
  });
});
