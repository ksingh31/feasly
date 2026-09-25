import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EmbedPublicConfig } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { EmbedConfigFailed, EmbedConfigLoaded, LoadEmbedConfig } from './embed.actions';
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
});
