/**
 * Builder Entra auth service specs (auth/02 pivot, builder parity).
 *
 * - `buildEntraLogoutUrl` points at the builder login page as the
 *   post-logout redirect and carries `id_token_hint` when the backend
 *   returned one, so Microsoft signs out the right session without an
 *   account picker and returns to /builder/login.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { BuilderEntraAuthService } from './builder-entra-auth.service';

describe('BuilderEntraAuthService', () => {
  let service: BuilderEntraAuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(BuilderEntraAuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('buildEntraLogoutUrl returns to /builder/login by default', () => {
    const endpoint =
      'https://feasly-dev.ciamlogin.com/tenant-id-123/oauth2/v2.0/logout';
    const url = new URL(service.buildEntraLogoutUrl(endpoint));
    expect(`${url.origin}${url.pathname}`).toBe(endpoint);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      `${window.location.origin}/builder/login`,
    );
    httpMock.verify();
  });

  it('buildEntraLogoutUrl appends id_token_hint when provided', () => {
    const endpoint =
      'https://feasly-dev.ciamlogin.com/tenant-id-123/oauth2/v2.0/logout';
    const url = new URL(service.buildEntraLogoutUrl(endpoint, 'stub-id-token'));
    expect(url.searchParams.get('id_token_hint')).toBe('stub-id-token');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      `${window.location.origin}/builder/login`,
    );
    httpMock.verify();
  });

  it('buildEntraLogoutUrl omits id_token_hint when null', () => {
    const endpoint =
      'https://feasly-dev.ciamlogin.com/tenant-id-123/oauth2/v2.0/logout';
    const url = new URL(service.buildEntraLogoutUrl(endpoint, null));
    expect(url.searchParams.has('id_token_hint')).toBe(false);
    httpMock.verify();
  });
});
