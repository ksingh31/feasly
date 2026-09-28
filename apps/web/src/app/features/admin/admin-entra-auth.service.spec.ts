/**
 * Entra auth service specs (auth/02 pivot).
 *
 * - The authorize URL shape: Microsoft-hosted host, tenant path,
 *   client_id, S256 PKCE, and the exact `openid profile email` scope.
 * - PKCE verifier + state are persisted in sessionStorage before the
 *   redirect so the callback page can complete the exchange.
 * - `consumeStoredFlow` reads once and clears (no replay).
 * - `isConfigured` rejects the compiled `ENTRA_*` placeholders.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { AdminEntraAuthService } from './admin-entra-auth.service';

const ENTRA = {
  tenantSubdomain: 'feasly-dev',
  tenantId: 'tenant-id-123',
  clientId: 'client-id-456',
  authorizeUrlTemplate:
    'https://{tenantSubdomain}.ciamlogin.com/{tenantId}/oauth2/v2.0/authorize',
};

describe('AdminEntraAuthService', () => {
  let service: AdminEntraAuthService;
  let httpMock: HttpTestingController;

  function loadEntraConfig(): Promise<void> {
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      admin: { entra: ENTRA },
    });
    return pending;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    service = TestBed.inject(AdminEntraAuthService);
    sessionStorage.clear();
  });

  it('isConfigured() is false with the compiled ENTRA_* placeholders', () => {
    expect(service.isConfigured()).toBe(false);
    httpMock.verify();
  });

  it('isConfigured() is true once real tenant values load', async () => {
    await loadEntraConfig();
    expect(service.isConfigured()).toBe(true);
    httpMock.verify();
  });

  it('buildAuthorizeUrl targets the Microsoft-hosted endpoint with PKCE S256', async () => {
    await loadEntraConfig();
    const redirectUri = 'https://app.example.com/admin/auth/callback';
    const url = new URL(await service.buildAuthorizeUrl(redirectUri));

    expect(url.origin).toBe(`https://${ENTRA.tenantSubdomain}.ciamlogin.com`);
    expect(url.pathname).toBe(`/${ENTRA.tenantId}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('client_id')).toBe(ENTRA.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9\-_]+$/);
    httpMock.verify();
  });

  it('buildAuthorizeUrl persists the verifier + state in sessionStorage', async () => {
    await loadEntraConfig();
    const url = new URL(
      await service.buildAuthorizeUrl('https://app.example.com/admin/auth/callback'),
    );
    expect(sessionStorage.getItem(AdminEntraAuthService.VERIFIER_KEY)).toMatch(
      /^[A-Za-z0-9\-_~.]{43,128}$/,
    );
    expect(sessionStorage.getItem(AdminEntraAuthService.STATE_KEY)).toBe(
      url.searchParams.get('state'),
    );
    httpMock.verify();
  });

  it('buildAuthorizeUrl throws when the tenant is not configured', async () => {
    await expect(
      service.buildAuthorizeUrl('https://app.example.com/admin/auth/callback'),
    ).rejects.toThrow('Entra is not configured');
    httpMock.verify();
  });

  it('consumeStoredFlow reads once and clears the pair', async () => {
    await loadEntraConfig();
    await service.buildAuthorizeUrl('https://app.example.com/admin/auth/callback');
    const first = service.consumeStoredFlow();
    expect(first.state).toBeTruthy();
    expect(first.codeVerifier).toBeTruthy();
    const second = service.consumeStoredFlow();
    expect(second.state).toBeNull();
    expect(second.codeVerifier).toBeNull();
    httpMock.verify();
  });

  it('callbackRedirectUri is the /admin/auth/callback URL', () => {
    expect(service.callbackRedirectUri()).toBe(
      `${window.location.origin}/admin/auth/callback`,
    );
    httpMock.verify();
  });
});
