import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { ApiKeyRecordResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { IssueApiKey } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { ApiKeysPageComponent } from './api-keys-page.component';

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

describe('ApiKeysPageComponent (api-mcp/02)', () => {
  let fixture: ComponentFixture<ApiKeysPageComponent>;
  let store: Store;

  beforeEach(async () => {
    const api = {
      listApiKeys: vi.fn().mockReturnValue(of({ keys: [keyRecord] })),
      issueApiKey: vi.fn(),
      rotateApiKey: vi.fn(),
      revokeApiKey: vi.fn(),
      updateApiKey: vi.fn(),
      getApiKeyUsage: vi.fn().mockReturnValue(of([])),
    };
    const config = {
      get: vi.fn((key: string) => {
        if (key === 'copy') {
          return {
            admin: {
              apiKeys: {
                title: 'API keys',
                plaintextWarning: 'Copy this key now',
                copyButton: 'Copy',
                copiedButton: 'Copied',
                confirmNo: 'Cancel',
                empty: 'No keys',
                loading: 'Loading…',
                loadError: 'Error',
              },
            },
          };
        }
        if (key === 'admin') {
          return { adminKey: 'secret', defaultRateLimit: 60 };
        }
        return {};
      }),
    };
    await TestBed.configureTestingModule({
      imports: [ApiKeysPageComponent],
      providers: [
        provideRouter([]),
        provideStore([ApiKeysState]),
        { provide: API_SERVICE, useValue: api },
        { provide: ConfigService, useValue: config },
        { provide: SeoService, useValue: { setForRoute: vi.fn() } },
      ],
    }).compileComponents();
    store = TestBed.inject(Store);
    fixture = TestBed.createComponent(ApiKeysPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('shows the once-only plaintext banner after issue', async () => {
    const api = TestBed.inject(API_SERVICE) as unknown as {
      issueApiKey: ReturnType<typeof vi.fn>;
    };
    api.issueApiKey.mockReturnValue(
      of({
        key: keyRecord,
        plaintext: 'feasly_live_secret_once',
      }),
    );
    await store.dispatch(new IssueApiKey({ name: 'Test' })).toPromise();
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector(
      '[data-testid="plaintext-banner"]',
    );
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('feasly_live_secret_once');
  });

  it('clears the plaintext when the component is destroyed (navigating away)', async () => {
    // Simulate an issued key in state
    store.reset({
      apiKeys: {
        keys: [keyRecord],
        loading: false,
        loadFailed: false,
        selectedId: null,
        plaintext: 'feasly_live_secret_once',
        plaintextKey: keyRecord,
        mutating: false,
        usage: [],
        usageLoading: false,
      },
    });
    fixture.detectChanges();
    let banner = fixture.nativeElement.querySelector('[data-testid="plaintext-banner"]');
    expect(banner).toBeTruthy();

    fixture.destroy();
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBeNull();
  });
});
