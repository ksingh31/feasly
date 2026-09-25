import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type {
  ApiKeyIssuedResponse,
  ApiKeyRecordResponse,
} from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import {
  ClearPlaintext,
  IssueApiKey,
  LoadApiKeys,
  RevokeApiKey,
  RotateApiKey,
  SelectApiKey,
  UpdateApiKey,
} from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';

const keyRecord: ApiKeyRecordResponse = {
  id: 'key-1',
  name: 'Test key',
  tenant_id: null,
  key_prefix: 'feasly_live_…abcd',
  scopes: ['estimate'],
  rate_limit_per_min: 60,
  sandbox: false,
  revoked_at: null,
  last_used_at: null,
  created_at: '2026-09-25T00:00:00.000Z',
};

function makeIssued(overrides: Partial<ApiKeyRecordResponse> = {}): ApiKeyIssuedResponse {
  return {
    key: { ...keyRecord, ...overrides },
    plaintext: 'feasly_live_plaintext_once',
  };
}

describe('ApiKeysState (api-mcp/02)', () => {
  let api: {
    listApiKeys: ReturnType<typeof vi.fn>;
    issueApiKey: ReturnType<typeof vi.fn>;
    rotateApiKey: ReturnType<typeof vi.fn>;
    revokeApiKey: ReturnType<typeof vi.fn>;
    updateApiKey: ReturnType<typeof vi.fn>;
    getApiKeyUsage: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    api = {
      listApiKeys: vi.fn(),
      issueApiKey: vi.fn(),
      rotateApiKey: vi.fn(),
      revokeApiKey: vi.fn(),
      updateApiKey: vi.fn(),
      getApiKeyUsage: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [provideStore([ApiKeysState]), { provide: API_SERVICE, useValue: api }],
    });
  });

  it('loads the key list', async () => {
    api.listApiKeys.mockReturnValue(of({ keys: [keyRecord] }));
    const store = TestBed.inject(Store);
    await store.dispatch(new LoadApiKeys()).toPromise();
    expect(store.selectSnapshot(ApiKeysState.keys)).toEqual([keyRecord]);
  });

  it('stores the once-only plaintext on issue and clears it on ClearPlaintext', async () => {
    api.issueApiKey.mockReturnValue(of(makeIssued()));
    const store = TestBed.inject(Store);
    await store.dispatch(new IssueApiKey({ name: 'Test' })).toPromise();
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBe('feasly_live_plaintext_once');
    // Navigating away clears it — the backend never returns it again.
    await store.dispatch(new ClearPlaintext()).toPromise();
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBeNull();
  });

  it('replaces the rotated key and shows the new plaintext once', async () => {
    api.listApiKeys.mockReturnValue(of({ keys: [keyRecord] }));
    const rotated = makeIssued({ id: 'key-2', name: 'Test key' });
    api.rotateApiKey.mockReturnValue(of(rotated));
    const store = TestBed.inject(Store);
    await store.dispatch(new LoadApiKeys()).toPromise();
    await store.dispatch(new RotateApiKey('key-1')).toPromise();
    const keys = store.selectSnapshot(ApiKeysState.keys) as ApiKeyRecordResponse[];
    expect(keys.map((k) => k.id)).toEqual(['key-2']);
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBe('feasly_live_plaintext_once');
  });

  it('removes the key on revoke', async () => {
    api.listApiKeys.mockReturnValue(of({ keys: [keyRecord] }));
    api.revokeApiKey.mockReturnValue(of({ revoked: true }));
    const store = TestBed.inject(Store);
    await store.dispatch(new LoadApiKeys()).toPromise();
    await store.dispatch(new SelectApiKey('key-1')).toPromise();
    await store.dispatch(new RevokeApiKey('key-1')).toPromise();
    expect(store.selectSnapshot(ApiKeysState.keys)).toEqual([]);
    expect(store.selectSnapshot(ApiKeysState.selected)).toBeNull();
  });

  it('applies the updated record after a scope/rate edit', async () => {
    api.listApiKeys.mockReturnValue(of({ keys: [keyRecord] }));
    const updated = { ...keyRecord, scopes: ['estimate', 'lead'] as const, rate_limit_per_min: 120 };
    api.updateApiKey.mockReturnValue(of(updated));
    const store = TestBed.inject(Store);
    await store.dispatch(new LoadApiKeys()).toPromise();
    await store.dispatch(new UpdateApiKey('key-1', { scopes: ['estimate', 'lead'], rate_limit_per_min: 120 })).toPromise();
    const keys = store.selectSnapshot(ApiKeysState.keys) as ApiKeyRecordResponse[];
    expect(keys[0].scopes).toEqual(['estimate', 'lead']);
    expect(keys[0].rate_limit_per_min).toBe(120);
    expect(api.updateApiKey).toHaveBeenCalledWith('key-1', {
      scopes: ['estimate', 'lead'],
      rate_limit_per_min: 120,
    });
  });

  it('flags a load failure without crashing', async () => {
    api.listApiKeys.mockReturnValue(throwError(() => new Error('denied')));
    const store = TestBed.inject(Store);
    await store.dispatch(new LoadApiKeys()).toPromise().catch(() => undefined);
    expect(store.selectSnapshot(ApiKeysState.loadFailed)).toBe(true);
  });
});
