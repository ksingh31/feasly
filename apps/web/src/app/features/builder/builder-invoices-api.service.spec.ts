/**
 * #661: the invoice PDF client — cookie-authenticated blob GET to
 * `/api/v1/billing/invoices/{id}/pdf`, with problem+json read back out of
 * a Blob error body.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { BuilderInvoicesApiService } from './builder-invoices-api.service';

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ConfigService,
        useValue: {
          get: (s: keyof typeof DEFAULT_APP_CONFIG) =>
            s === 'api' ? { ...DEFAULT_APP_CONFIG.api, baseUrl: 'https://api.test' } : DEFAULT_APP_CONFIG[s],
        },
      },
    ],
  });
  return {
    api: TestBed.inject(BuilderInvoicesApiService),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('BuilderInvoicesApiService.downloadInvoicePdf (#661)', () => {
  it('GETs the PDF as a blob with the builder session cookie', async () => {
    const { api, http } = setup();
    const result = firstValueFrom(api.downloadInvoicePdf('inv-1'));
    const req = http.expectOne('https://api.test/api/v1/billing/invoices/inv-1/pdf');
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.responseType).toBe('blob');
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    req.flush(blob);
    expect(await result).toBe(blob);
    http.verify();
  });

  it('maps a 404 problem in a Blob body to an ApiError', async () => {
    const { api, http } = setup();
    const result = firstValueFrom(api.downloadInvoicePdf('inv-2'));
    http
      .expectOne('https://api.test/api/v1/billing/invoices/inv-2/pdf')
      .flush(new Blob([JSON.stringify({ status: 404, code: 'NOT_FOUND', detail: 'Invoice not found.' })]), {
        status: 404,
        statusText: 'Not Found',
      });
    await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
    http.verify();
  });
});
