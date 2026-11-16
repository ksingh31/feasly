/**
 * Real-user monitoring ingest tests (#830): closed shape, size bounds,
 * text/plain (string) beacon bodies, defensive PII scrubbing, and one trace
 * per item through the injected sink.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createComposition } from '../src/composition';
import {
  createWebTelemetryService,
  scrubTelemetryText,
  WEB_TELEMETRY_MAX_ITEMS,
  WEB_TELEMETRY_MAX_MESSAGE,
  type WebTelemetryTrace,
} from '../src/services/web-telemetry.service';
import { createWebTelemetryRoute } from '../src/routes/web-telemetry.route';
import { ErrorCodes, HttpError, isProblemDetails } from '../src/middleware/errors';

function setup() {
  const traces: WebTelemetryTrace[] = [];
  const service = createWebTelemetryService({ onTrace: (t) => traces.push(t) });
  return { traces, service };
}

const vital = { type: 'vital', name: 'LCP', value: 1234.5, rating: 'good', page: '/estimate/scope' };
const error = {
  type: 'error',
  kind: 'error',
  message: 'TypeError: x is undefined',
  source: 'https://feasly.example/main-ABC.js?v=1',
  line: 10,
  column: 4,
  page: '/report/:token',
};

async function expect400(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  const http = err as HttpError;
  expect(http.status).toBe(400);
  expect(http.code).toBe(ErrorCodes.VALIDATION_FAILED);
  return http;
}

describe('web telemetry service (#830)', () => {
  it('emits one trace per item and reports the accepted count', async () => {
    const { traces, service } = setup();
    await expect(service.ingest({ items: [vital, error] })).resolves.toEqual({ accepted: 2 });
    expect(traces).toEqual([
      { event: 'web_vital', name: 'LCP', value: 1234.5, rating: 'good', page: '/estimate/scope' },
      {
        event: 'web_error',
        kind: 'error',
        message: 'TypeError: x is undefined',
        source: '/main-ABC.js',
        line: 10,
        column: 4,
        page: '/report/:token',
      },
    ]);
  });

  it('accepts a text/plain JSON string body (sendBeacon)', async () => {
    const { traces, service } = setup();
    await expect(service.ingest(JSON.stringify({ items: [vital] }))).resolves.toEqual({ accepted: 1 });
    expect(traces).toHaveLength(1);
  });

  it('rejects a non-JSON string body', async () => {
    const { traces, service } = setup();
    await expect400(service.ingest('not json'));
    expect(traces).toHaveLength(0);
  });

  it('rejects unknown keys so no PII can be smuggled in', async () => {
    const { service } = setup();
    const err = await expect400(service.ingest({ items: [{ ...vital, email: 'a@b.co' }] }));
    expect(err.message).not.toContain('a@b.co');
  });

  it('rejects unknown metric names, empty and oversized batches', async () => {
    const { service } = setup();
    await expect400(service.ingest({ items: [{ ...vital, name: 'FID' }] }));
    await expect400(service.ingest({ items: [] }));
    await expect400(
      service.ingest({ items: Array.from({ length: WEB_TELEMETRY_MAX_ITEMS + 1 }, () => vital) }),
    );
    await expect400(service.ingest({ items: [{ ...vital, value: -1 }] }));
    await expect400(service.ingest(undefined));
  });

  it('scrubs emails and query strings from error text and truncates', async () => {
    const { traces, service } = setup();
    await service.ingest({
      items: [
        {
          ...error,
          message: `Failed for jane@example.com at https://x.test/r?token=secret#frag ${'z'.repeat(2 * WEB_TELEMETRY_MAX_MESSAGE)}`,
        },
      ],
    });
    const trace = traces[0] as Extract<WebTelemetryTrace, { event: 'web_error' }>;
    expect(trace.message).not.toContain('jane@example.com');
    expect(trace.message).not.toContain('secret');
    expect(trace.message).toContain('[email]');
    expect(trace.message.length).toBe(WEB_TELEMETRY_MAX_MESSAGE);
  });

  it('scrubTelemetryText strips query and fragment', () => {
    expect(scrubTelemetryText('/a/b?x=1#y', 100)).toBe('/a/b');
  });

  it('route delegates to the service', async () => {
    const { traces, service } = setup();
    const route = createWebTelemetryRoute({ webTelemetry: service });
    await expect(route.handle({ items: [vital] })).resolves.toEqual({ accepted: 1 });
    expect(traces).toHaveLength(1);
  });

  it('drops items past the per-instance trace budget and resets after a minute', async () => {
    const traces: WebTelemetryTrace[] = [];
    let t = 1_000_000;
    const service = createWebTelemetryService({
      onTrace: (tr) => traces.push(tr),
      maxTracesPerMinute: 3,
      now: () => t,
    });
    await expect(service.ingest({ items: [vital, vital] })).resolves.toEqual({ accepted: 2 });
    await expect(service.ingest({ items: [vital, vital] })).resolves.toEqual({ accepted: 1 });
    await expect(service.ingest({ items: [vital] })).resolves.toEqual({ accepted: 0 });
    expect(traces).toHaveLength(3);
    t += 60_000;
    await expect(service.ingest({ items: [vital] })).resolves.toEqual({ accepted: 1 });
    expect(traces).toHaveLength(4);
  });
});

describe('web telemetry pipeline (#830 review: own tight limiter)', () => {
  const app = createComposition({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/feasly_test',
  } as NodeJS.ProcessEnv);
  afterAll(async () => {
    await app.db.close();
  });

  it('defaults to 10/min per IP, separate from the analytics limiter', async () => {
    const run = () =>
      app.webTelemetryPipeline.run({ headers: {}, clientIp: '10.9.0.1' }, () =>
        app.webTelemetryRoute.handle({ items: [vital] }),
      );
    for (let i = 0; i < 10; i++) {
      expect(isProblemDetails(await run())).toBe(false);
    }
    const outcome = await run();
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(429);
      expect(outcome.code).toBe('RATE_LIMITED');
    }
    // The analytics limiter is untouched by telemetry traffic.
    expect(app.webTelemetryRateLimiter).not.toBe(app.analyticsRateLimiter);
  });
});
