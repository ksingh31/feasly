import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BOT_CHALLENGE_HEADER } from '@feasly/contracts';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../config/config.service';
import { HttpApiService } from './http-api.service';
import { providePropertyData } from './property-data.service';
import { TurnstileChallengeService } from './turnstile-challenge.service';

/**
 * #905: the lead and estimate routes recover from a #788 bot-challenge 403
 * with one invisible Turnstile run and exactly one retry carrying the token.
 */
describe('HttpApiService bot challenge (#905)', () => {
  const BASE = '/api/v1';
  const SITE_KEY = 'site-key-from-api-response';
  let service: HttpApiService;
  let httpMock: HttpTestingController;
  let solve: ReturnType<typeof vi.fn<(siteKey: string) => Observable<string>>>;

  const challengeBody = (code = 'CHALLENGE_REQUIRED') => ({
    code,
    message: 'Please confirm you are not a bot, then try again.',
    retryable: false,
    challenge: { provider: 'turnstile', siteKey: SITE_KEY },
  });
  const forbidden = { status: 403, statusText: 'Forbidden' };

  const estimateRequest = {
    projectType: 'new_build',
    property: {
      addressKey: 'calgary-1234-14-st-nw',
      assessedLandValue: 4930000,
      lotSizeSqft: 5000,
      zoning: 'R-CG',
    },
    scope: { buildSqft: 2400, tier: 'premium', garage: 'double', basement: 'unfinished' },
  } as const;
  const lead = {
    email: 'buyer@example.com',
    name: 'Test Buyer',
    timeline: '6-12mo',
    marketingConsent: false,
    estimateId: 'est-mock-1',
  } as const;

  beforeEach(async () => {
    solve = vi.fn<(siteKey: string) => Observable<string>>(() => of('turnstile-token'));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        { provide: TurnstileChallengeService, useValue: { solve } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { baseUrl: '', useMockApi: false, timeoutMs: 15000 },
      propertyData: { source: 'backend' },
    });
    await pending;
    service = TestBed.inject(HttpApiService);
  });

  const flows: { name: string; url: string; call: (api: HttpApiService) => Observable<unknown> }[] = [
    { name: 'submitLead (gate)', url: `${BASE}/leads`, call: (api) => api.submitLead(lead) },
    {
      name: 'getPreviewEstimate',
      url: `${BASE}/estimates/preview`,
      call: (api) => api.getPreviewEstimate(estimateRequest),
    },
    { name: 'getEstimate', url: `${BASE}/estimate`, call: (api) => api.getEstimate(estimateRequest) },
    {
      name: 'getComparisonEstimate',
      url: `${BASE}/estimate`,
      call: (api) =>
        api.getComparisonEstimate(
          estimateRequest as unknown as Parameters<HttpApiService['getComparisonEstimate']>[0],
        ),
    },
  ];

  for (const flow of flows) {
    it(`${flow.name}: solves the challenge with the API's site key and retries once with the token`, async () => {
      const pending = firstValueFrom(flow.call(service));
      const first = httpMock.expectOne(flow.url);
      expect(first.request.headers.has(BOT_CHALLENGE_HEADER)).toBe(false);
      first.flush(challengeBody(), forbidden);

      const retry = httpMock.expectOne(flow.url);
      expect(retry.request.headers.get(BOT_CHALLENGE_HEADER)).toBe('turnstile-token');
      expect(retry.request.body).toEqual(first.request.body);
      retry.flush({ ok: true });

      await expect(pending).resolves.toEqual({ ok: true });
      expect(solve).toHaveBeenCalledTimes(1);
      expect(solve).toHaveBeenCalledWith(SITE_KEY);
      httpMock.verify();
    });
  }

  it('also recovers from CHALLENGE_FAILED', async () => {
    const pending = firstValueFrom(service.submitLead(lead));
    httpMock.expectOne(`${BASE}/leads`).flush(challengeBody('CHALLENGE_FAILED'), forbidden);
    httpMock.expectOne(`${BASE}/leads`).flush({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('retries only once: a second challenge 403 surfaces as the honest error', async () => {
    const pending = firstValueFrom(service.submitLead(lead));
    httpMock.expectOne(`${BASE}/leads`).flush(challengeBody(), forbidden);
    httpMock.expectOne(`${BASE}/leads`).flush(challengeBody('CHALLENGE_FAILED'), forbidden);
    await expect(pending).rejects.toMatchObject({ code: 'CHALLENGE_FAILED', retryable: false });
    expect(solve).toHaveBeenCalledTimes(1);
    httpMock.verify();
  });

  it('surfaces the original 403 when the challenge cannot complete (no retry)', async () => {
    solve.mockReturnValue(throwError(() => new Error('script blocked')));
    const pending = firstValueFrom(service.getEstimate(estimateRequest));
    httpMock.expectOne(`${BASE}/estimate`).flush(challengeBody(), forbidden);
    await expect(pending).rejects.toMatchObject({
      code: 'CHALLENGE_REQUIRED',
      message: 'Please confirm you are not a bot, then try again.',
    });
    httpMock.verify();
  });

  it('never runs the challenge on the normal path or for other errors', async () => {
    const ok = firstValueFrom(service.getEstimate(estimateRequest));
    httpMock.expectOne(`${BASE}/estimate`).flush({ ok: true });
    await expect(ok).resolves.toEqual({ ok: true });

    const denied = firstValueFrom(service.submitLead(lead));
    httpMock
      .expectOne(`${BASE}/leads`)
      .flush({ code: 'FORBIDDEN', message: 'No.', retryable: false }, forbidden);
    await expect(denied).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(solve).not.toHaveBeenCalled();
    httpMock.verify();
  });

  it('does not run the challenge on routes outside the lead/estimate flows', async () => {
    const pending = firstValueFrom(service.requestCallback({} as never));
    httpMock.expectOne(`${BASE}/callbacks`).flush(challengeBody(), forbidden);
    await expect(pending).rejects.toMatchObject({ code: 'CHALLENGE_REQUIRED' });
    expect(solve).not.toHaveBeenCalled();
  });
});
