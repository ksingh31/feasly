import { Component, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metric } from 'web-vitals';
import type { WebTelemetryBatch } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import { DEFAULT_APP_CONFIG } from '../config/app-config.defaults';
import type { AppConfig } from '../config/app-config';
import { WebTelemetryService, type WebVitalsLoader } from './web-telemetry.service';

@Component({ template: '' })
class StubComponent {}

type Callback = (m: Metric) => void;

/** #830: sampled real-user monitoring — vitals + errors via sendBeacon, no PII. */
describe('WebTelemetryService', () => {
  let beacon: ReturnType<typeof vi.fn>;
  let callbacks: Record<string, Callback>;
  let telemetryCfg: AppConfig['telemetry'];
  let apiCfg: AppConfig['api'];

  function setup(platform = 'browser'): WebTelemetryService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: platform },
        {
          provide: ConfigService,
          useValue: {
            get: (k: keyof AppConfig) => (k === 'telemetry' ? telemetryCfg : k === 'api' ? apiCfg : DEFAULT_APP_CONFIG[k]),
          },
        },
        provideRouter([
          { path: '', component: StubComponent },
          { path: 'report/:token', component: StubComponent },
        ]),
      ],
    });
    const service = TestBed.inject(WebTelemetryService);
    service.random = () => 0.1;
    const loader: WebVitalsLoader = () =>
      Promise.resolve({
        onLCP: (cb: Callback) => (callbacks['LCP'] = cb),
        onINP: (cb: Callback) => (callbacks['INP'] = cb),
        onCLS: (cb: Callback) => (callbacks['CLS'] = cb),
        onTTFB: (cb: Callback) => (callbacks['TTFB'] = cb),
      } as unknown as Awaited<ReturnType<WebVitalsLoader>>);
    service.loader = loader;
    return service;
  }

  async function sentBatches(): Promise<WebTelemetryBatch[]> {
    return Promise.all(
      beacon.mock.calls.map(async ([, blob]) => JSON.parse(await (blob as Blob).text()) as WebTelemetryBatch),
    );
  }

  /** Polls until web-vitals callbacks are registered (no fixed sleeps). */
  async function waitForVitals(): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!callbacks['TTFB']) {
      if (Date.now() > deadline) throw new Error('web-vitals never registered');
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  function hidePage(): void {
    window.dispatchEvent(new Event('pagehide'));
  }

  beforeEach(() => {
    callbacks = {};
    beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true });
    telemetryCfg = { ...DEFAULT_APP_CONFIG.telemetry, sampleRate: 0.25 };
    apiCfg = { ...DEFAULT_APP_CONFIG.api, baseUrl: 'https://api.test', useMockApi: false };
  });

  afterEach(() => TestBed.resetTestingModule());

  it('sends vitals with the route pattern (never the concrete URL) on page hide', async () => {
    const service = setup();
    await TestBed.inject(Router).navigateByUrl('/report/secret-token?utm=x');
    service.start();
    await waitForVitals();
    callbacks['LCP']({ name: 'LCP', value: 1800, rating: 'good' } as Metric);
    callbacks['CLS']({ name: 'CLS', value: 0.02, rating: 'good' } as Metric);
    hidePage();

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe('https://api.test/api/v1/telemetry');
    expect((beacon.mock.calls[0][1] as Blob).type).toBe('text/plain');
    const [batch] = await sentBatches();
    expect(batch.items).toEqual([
      { type: 'vital', name: 'LCP', value: 1800, rating: 'good', page: '/report/:token' },
      { type: 'vital', name: 'CLS', value: 0.02, rating: 'good', page: '/report/:token' },
    ]);
    expect(JSON.stringify(batch)).not.toContain('secret-token');
  });

  it('reports each error once, with a script path only, capped per page load', async () => {
    telemetryCfg = { ...telemetryCfg, maxErrorsPerSession: 2 };
    const service = setup();
    service.start();
    await waitForVitals();
    const err = new TypeError('x is undefined');
    window.dispatchEvent(
      new ErrorEvent('error', { error: err, message: err.message, filename: 'https://x.test/main.js?v=1', lineno: 3, colno: 7 }),
    );
    service.recordError(err); // Angular's ErrorHandler sees the same object
    service.recordError(new Error('second'));
    service.recordError(new Error('third — over the cap'));
    hidePage();

    const [batch] = await sentBatches();
    expect(batch.items).toEqual([
      { type: 'error', kind: 'error', message: 'TypeError: x is undefined', source: '/main.js', line: 3, column: 7, page: '/' },
      { type: 'error', kind: 'error', message: 'Error: second', page: '/' },
    ]);
  });

  it('reports HttpErrorResponse-like objects by message with URLs reduced to masked paths', async () => {
    const service = setup();
    service.start();
    service.recordError({
      name: 'HttpErrorResponse',
      message: 'Http failure response for https://api.x.test/api/v1/report/Ab3dEf9hIjKlMnOp?x=1: 500 Server Error',
    });
    service.recordError({
      name: 'HttpErrorResponse',
      message: 'Http failure response for https://api.x.test/api/v1/estimates/7f3c2a1b-0000-4000-8000-1234567890ab: 0 Unknown Error',
    });
    await waitForVitals();
    hidePage();
    const [batch] = await sentBatches();
    expect(batch.items[0]).toMatchObject({
      message: 'HttpErrorResponse: Http failure response for /api/v1/report/:id: 500 Server Error',
    });
    expect(batch.items[1]).toMatchObject({
      message: 'HttpErrorResponse: Http failure response for /api/v1/estimates/:id: 0 Unknown Error',
    });
    expect(JSON.stringify(batch)).not.toContain('Ab3dEf9hIjKlMnOp');
    expect(JSON.stringify(batch)).not.toContain('7f3c2a1b');
  });

  it('truncates error messages', async () => {
    telemetryCfg = { ...telemetryCfg, maxMessageLength: 5 };
    const service = setup();
    service.start();
    service.recordError('abcdefghij');
    await waitForVitals();
    hidePage();
    const [batch] = await sentBatches();
    expect(batch.items[0]).toMatchObject({ message: 'abcde' });
  });

  it('flushes as soon as a batch is full', () => {
    telemetryCfg = { ...telemetryCfg, maxBatchItems: 2 };
    const service = setup();
    service.start();
    service.recordError(new Error('a'));
    expect(beacon).not.toHaveBeenCalled();
    service.recordError(new Error('b'));
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('stays off when not sampled in, disabled, in mock-API mode, or on the server', () => {
    const notSampled = setup();
    notSampled.random = () => 0.9;
    notSampled.start();
    expect(notSampled.isActive).toBe(false);

    telemetryCfg = { ...telemetryCfg, enabled: false };
    const disabled = setup();
    disabled.start();
    expect(disabled.isActive).toBe(false);

    telemetryCfg = { ...telemetryCfg, enabled: true };
    apiCfg = { ...apiCfg, useMockApi: true };
    const mock = setup();
    mock.start();
    expect(mock.isActive).toBe(false);

    apiCfg = { ...apiCfg, useMockApi: false };
    const server = setup('server');
    server.start();
    expect(server.isActive).toBe(false);
    server.recordError(new Error('ignored'));
    server.flush();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('stays off in automated browsers (Lighthouse, Playwright) so web-vitals never loads (#957)', () => {
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });
    try {
      const service = setup();
      const loader = vi.fn(service.loader);
      service.loader = loader;
      service.start();
      expect(service.isActive).toBe(false);
      expect(loader).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true });
    }
  });
});
