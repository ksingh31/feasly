import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectivityService } from './connectivity.service';
import { connectivityInterceptor } from './connectivity.interceptor';

/**
 * HRD-02: a request that dies at the network layer (status 0) re-verifies
 * reachability; ordinary HTTP errors and the health probe itself do not.
 */
describe('connectivityInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let markUnreachable: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    markUnreachable = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([connectivityInterceptor])),
        provideHttpClientTesting(),
        {
          provide: ConnectivityService,
          useValue: { markUnreachable, checkHealth: vi.fn(), offline: () => false },
        },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('calls markUnreachable() when a request fails with status 0', () => {
    http.get('/api/v1/estimates').subscribe({ error: () => undefined });
    httpMock.expectOne('/api/v1/estimates').error(new ProgressEvent('error'), { status: 0 });
    expect(markUnreachable).toHaveBeenCalledTimes(1);
  });

  it('does NOT call markUnreachable() for HTTP error statuses', () => {
    http.get('/api/v1/estimates').subscribe({ error: () => undefined });
    httpMock.expectOne('/api/v1/estimates').flush('nope', { status: 500, statusText: 'x' });
    expect(markUnreachable).not.toHaveBeenCalled();
  });

  it('skips the health probe itself (no probe loops)', () => {
    http.get('/api/health').subscribe({ error: () => undefined });
    httpMock.expectOne('/api/health').error(new ProgressEvent('error'), { status: 0 });
    expect(markUnreachable).not.toHaveBeenCalled();
  });
});
