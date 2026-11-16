/**
 * Real-user monitoring ingest tests (#830): closed shape, size bounds,
 * text/plain (string) beacon bodies, defensive PII scrubbing, and one trace
 * per item through the injected sink.
 */
import { describe, expect, it } from 'vitest';
import {
  createWebTelemetryService,
  scrubTelemetryText,
  WEB_TELEMETRY_MAX_ITEMS,
  WEB_TELEMETRY_MAX_MESSAGE,
  type WebTelemetryTrace,
} from '../src/services/web-telemetry.service';
import { createWebTelemetryRoute } from '../src/routes/web-telemetry.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

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
});
