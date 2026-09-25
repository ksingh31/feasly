import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service';
import { ConnectivityService } from './connectivity.service';

/**
 * HRD-02: the shell detects an unreachable API via the health probe and
 * renders the offline state. Only network-level failures count as offline —
 * an HTTP 500 means reachable-but-sick (/error territory, not offline).
 */
describe('ConnectivityService', () => {
  const baseUrl = 'https://api.test';
  let httpMock: HttpTestingController;
  let service: ConnectivityService;

  /** Creates the service and settles its constructor probe. */
  async function createWithProbeResult(
    respond: (req: ReturnType<HttpTestingController['expectOne']>) => void,
  ): Promise<ConnectivityService> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({ api: { baseUrl } });
    await pending;
    const svc = TestBed.inject(ConnectivityService);
    respond(httpMock.expectOne(`${baseUrl}/api/health`));
    return svc;
  }

  it('a network-level probe failure flags offline', async () => {
    service = await createWithProbeResult((req) =>
      req.error(new ProgressEvent('error'), { status: 0 }),
    );
    expect(service.offline()).toBe(true);
  });

  it('a successful probe clears the offline flag', async () => {
    service = await createWithProbeResult((req) =>
      req.error(new ProgressEvent('error'), { status: 0 }),
    );
    expect(service.offline()).toBe(true);

    service.checkHealth();
    httpMock.expectOne(`${baseUrl}/api/health`).flush('ok');
    expect(service.offline()).toBe(false);
  });

  it('an HTTP 500 on the probe does NOT flag offline (reachable but sick)', async () => {
    service = await createWithProbeResult((req) =>
      req.flush('sick', { status: 500, statusText: 'Server Error' }),
    );
    expect(service.offline()).toBe(false);
  });

  it('markUnreachable() re-probes the health endpoint', async () => {
    service = await createWithProbeResult((req) => req.flush('ok'));
    expect(service.offline()).toBe(false);

    service.markUnreachable();
    httpMock.expectOne(`${baseUrl}/api/health`).flush('ok');
    expect(service.offline()).toBe(false);
  });
});
