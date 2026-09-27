import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EmbedPublicConfig } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  EmbedConfigFailed,
  EmbedConfigLoaded,
  ExchangeRelayCode,
  LoadEmbedConfig,
  ResendRelayCode,
} from './embed.actions';
import { EmbedState, type EmbedStateModel } from './embed.state';

/** EMB-01: embed state transitions — load, success, and failure paths. */
describe('EmbedState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  const fakeConfig = {
    business_name: 'Elite Craft Builders',
    display_name: 'Elite Craft',
    logo_url: '',
    accent_color: '#a8761a',
    allowed_origins: ['https://example-builder.com'],
    fallback_phone: '(403) 555-0100',
    fallback_email: 'hello@example-builder.com',
    plan: null,
  } as EmbedPublicConfig;

  function snapshot(): EmbedStateModel {
    return store.selectSnapshot<EmbedStateModel>((state) => state.embed);
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideStore([EmbedState])],
    });
    httpMock = TestBed.inject(HttpTestingController);
    TestBed.inject(ConfigService);
    store = TestBed.inject(Store);
  });

  it('starts idle with no tenant or config', () => {
    expect(snapshot()).toEqual({
      tenantKey: null,
      config: null,
      status: 'idle',
      error: null,
      relayStatus: 'none',
      sessionToken: null,
      sessionEstimateId: null,
      sessionLeadScore: null,
      relayError: null,
      relayCode: null,
      resending: false,
      resendError: null,
    });
  });

  it('loads the config for the tenant key and becomes ready', async () => {
    const done = store.dispatch(new LoadEmbedConfig('elite-craft'));
    expect(snapshot().status).toBe('loading');
    expect(snapshot().tenantKey).toBe('elite-craft');

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/config'));
    expect(req.request.params.get('key')).toBe('elite-craft');
    req.flush(fakeConfig);
    await done;

    const s = snapshot();
    expect(s.status).toBe('ready');
    expect(s.config).toEqual(fakeConfig);
    expect(s.error).toBeNull();
    httpMock.verify();
  });

  it('maps an unknown tenant (404) to the error state with the code', async () => {
    const done = store.dispatch(new LoadEmbedConfig('nope'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/config'));
    req.flush(
      { code: 'UNKNOWN_TENANT', message: 'Unknown tenant' },
      { status: 404, statusText: 'Not Found' },
    );
    await done;

    const s = snapshot();
    expect(s.status).toBe('error');
    expect(s.config).toBeNull();
    expect(s.error).toBe('UNKNOWN_TENANT');
    httpMock.verify();
  });

  it('EmbedConfigFailed sets the error state directly (e.g. missing key)', async () => {
    await store.dispatch(new EmbedConfigFailed('missing_key')).toPromise();
    const s = snapshot();
    expect(s.status).toBe('error');
    expect(s.error).toBe('missing_key');
    httpMock.expectNone((r) => r.url.endsWith('/api/v1/embed/config'));
  });

  it('EmbedConfigLoaded applies the config and clears errors', async () => {
    await store.dispatch(new EmbedConfigLoaded(fakeConfig)).toPromise();
    const s = snapshot();
    expect(s.status).toBe('ready');
    expect(s.config?.display_name).toBe('Elite Craft');
  });

  it('exposes selectors for status, config, and tenant key', async () => {
    await store.dispatch(new EmbedConfigLoaded(fakeConfig)).toPromise();
    expect(store.selectSnapshot(EmbedState.status)).toBe('ready');
    expect(store.selectSnapshot(EmbedState.config)?.business_name).toBe('Elite Craft Builders');
    expect(store.selectSnapshot(EmbedState.tenantKey)).toBeNull();
  });

  describe('relay resend (embed/06 AC3)', () => {
    const OLD_CODE =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const NEW_CODE =
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

    /** Load config, then fail an exchange so the shell sits in the expired state. */
    async function arrangeFailedExchange(): Promise<void> {
      const load = store.dispatch(new LoadEmbedConfig('elite-craft'));
      const cfgReq = httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/config'));
      cfgReq.flush(fakeConfig);
      await load;

      const exchange = store.dispatch(new ExchangeRelayCode(OLD_CODE));
      const exReq = httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/session'));
      exReq.flush(
        { code: 'RELAY_CODE_INVALID', message: 'expired' },
        { status: 410, statusText: 'Gone' },
      );
      await exchange;
      expect(snapshot().relayStatus).toBe('failed');
    }

    it('re-issues and immediately exchanges the fresh code', async () => {
      await arrangeFailedExchange();

      const done = store.dispatch(new ResendRelayCode());
      expect(snapshot().resending).toBe(true);
      const resendReq = httpMock.expectOne((r) =>
        r.url.endsWith('/api/v1/embed/relay/resend'),
      );
      expect(resendReq.request.body).toEqual({
        code: OLD_CODE,
        tenant_key: 'elite-craft',
      });
      resendReq.flush({ code: NEW_CODE, expiresInSeconds: 600 });

      // The fresh code is exchanged immediately — no parent involvement.
      const exReq = httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/session'));
      expect(exReq.request.body).toEqual({ code: NEW_CODE, tenant_key: 'elite-craft' });
      exReq.flush({
        sessionToken: 'sess-123',
        estimateId: 'est-1',
        leadScore: 72,
        expiresInSeconds: 43_200,
      });
      await done;
      httpMock.verify();

      const s = snapshot();
      expect(s.relayStatus).toBe('active');
      expect(s.sessionToken).toBe('sess-123');
      expect(s.resending).toBe(false);
      expect(s.resendError).toBeNull();
      // The old code is gone from memory once the session is live.
      expect(s.relayCode).toBeNull();
    });

    it('maps the 60s cooldown (429) to resendError=cooldown', async () => {
      await arrangeFailedExchange();

      const resend = store.dispatch(new ResendRelayCode());
      const resendReq = httpMock.expectOne((r) =>
        r.url.endsWith('/api/v1/embed/relay/resend'),
      );
      resendReq.flush(
        { code: 'RATE_LIMITED', message: 'A fresh link was just issued.' },
        { status: 429, statusText: 'Too Many Requests' },
      );
      await resend;

      const s = snapshot();
      expect(s.resending).toBe(false);
      expect(s.resendError).toBe('cooldown');
      // Still in the expired state — the user can retry after a minute.
      expect(s.relayStatus).toBe('failed');
      httpMock.expectNone((r) => r.url.endsWith('/api/v1/embed/session'));
      httpMock.verify();
    });

    it('maps other failures to resendError=failed', async () => {
      await arrangeFailedExchange();

      const resend = store.dispatch(new ResendRelayCode());
      const resendReq = httpMock.expectOne((r) =>
        r.url.endsWith('/api/v1/embed/relay/resend'),
      );
      resendReq.flush(
        { code: 'RELAY_CODE_INVALID', message: 'invalid' },
        { status: 410, statusText: 'Gone' },
      );
      await resend;

      const s = snapshot();
      expect(s.resending).toBe(false);
      expect(s.resendError).toBe('failed');
      expect(s.relayStatus).toBe('failed');
      httpMock.verify();
    });

    it('ignores a second resend while one is in flight', async () => {
      await arrangeFailedExchange();

      store.dispatch(new ResendRelayCode());
      store.dispatch(new ResendRelayCode());
      httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/relay/resend'));
      httpMock.verify();
    });
  });
});
