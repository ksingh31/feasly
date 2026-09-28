/**
 * Admin auth state tests (admin/01 + auth/02).
 *
 * Verifies: token verify/load transitions (bearer token stored on
 * success, cleared on failure/logout), expired-session flagging for the
 * login copy, logout clearing, and the auth/02 password-login action
 * (identity stored on success; 401/429/transient classified and surfaced
 * as lastLoginError; error cleared on retry and on success).
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import {
  ClearAdminAuth,
  LoadAdminSession,
  LoginAdminWithPassword,
  LogoutAdmin,
  VerifyAdminToken,
} from './admin-auth.actions';
import { AdminAuthState, type AdminAuthStateModel } from './admin-auth.state';

describe('AdminAuthState (admin/01)', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  function snapshot(): AdminAuthStateModel {
    return store.selectSnapshot<AdminAuthStateModel>(
      (state) => state.adminAuth,
    );
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([AdminAuthState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    TestBed.inject(ConfigService);
    store = TestBed.inject(Store);
  });

  it('starts unknown with no token', () => {
    const s = snapshot();
    expect(s.authStatus).toBe('unknown');
    expect(s.sessionToken).toBeNull();
    expect(s.email).toBeNull();
    expect(s.sessionExpired).toBe(false);
    httpMock.verify();
  });

  it('VerifyAdminToken stores the bearer token on success', async () => {
    const done = store.dispatch(new VerifyAdminToken('magic-tok'));
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/auth/verify'),
    );
    expect(req.request.params.get('token')).toBe('magic-tok');
    req.flush({
      authenticated: true,
      email: 'admin@example.com',
      sessionToken: 'sess-abc',
      setCookie: 'c',
    });
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('authenticated');
    expect(s.sessionToken).toBe('sess-abc');
    expect(s.email).toBe('admin@example.com');
    expect(store.selectSnapshot(AdminAuthState.authenticated)).toBe(true);
    httpMock.verify();
  });

  it('VerifyAdminToken marks unauthenticated and clears the token on failure', async () => {
    const done = store.dispatch(new VerifyAdminToken('bad-token'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush({ message: 'invalid' }, { status: 401, statusText: 'Unauthorized' });
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('unauthenticated');
    expect(s.sessionToken).toBeNull();
    expect(s.email).toBeNull();
    httpMock.verify();
  });

  it('LoadAdminSession re-authenticates without dropping the stored token', async () => {
    const verify = store.dispatch(new VerifyAdminToken('magic-tok'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush({
        authenticated: true,
        email: 'admin@example.com',
        sessionToken: 'sess-abc',
        setCookie: 'c',
      });
    await verify;

    const done = store.dispatch(new LoadAdminSession());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/me'))
      .flush({ authenticated: true, email: 'admin@example.com' });
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('authenticated');
    expect(s.sessionToken).toBe('sess-abc');
    httpMock.verify();
  });

  it('LoadAdminSession clears the token and flags expiry on 401 SESSION_EXPIRED', async () => {
    const done = store.dispatch(new LoadAdminSession());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/me'))
      .flush(
        { code: 'SESSION_EXPIRED', message: 'expired' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('unauthenticated');
    expect(s.sessionToken).toBeNull();
    expect(s.sessionExpired).toBe(true);
    httpMock.verify();
  });

  it('LogoutAdmin clears the token', async () => {
    const verify = store.dispatch(new VerifyAdminToken('magic-tok'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush({
        authenticated: true,
        email: 'admin@example.com',
        sessionToken: 'sess-abc',
        setCookie: 'c',
      });
    await verify;

    const done = store.dispatch(new LogoutAdmin());
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/auth/logout'),
    );
    expect(req.request.method).toBe('POST');
    req.flush({ loggedOut: true, setCookie: 'cleared' });
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('unknown');
    expect(s.sessionToken).toBeNull();
    expect(s.email).toBeNull();
    httpMock.verify();
  });

  it('ClearAdminAuth resets the slice', async () => {
    const verify = store.dispatch(new VerifyAdminToken('magic-tok'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush({
        authenticated: true,
        email: 'admin@example.com',
        sessionToken: 'sess-abc',
        setCookie: 'c',
      });
    await verify;

    await store.dispatch(new ClearAdminAuth());
    const s = snapshot();
    expect(s.sessionToken).toBeNull();
    expect(s.authStatus).toBe('unknown');
    httpMock.verify();
  });

  it("VerifyAdminToken classifies a consumed token as 'used'", async () => {
    const done = store.dispatch(new VerifyAdminToken('used-token'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush(
        { code: 'MAGIC_LINK_USED', message: 'already been used' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('unauthenticated');
    expect(s.lastVerifyError).toBe('used');
    expect(store.selectSnapshot(AdminAuthState.lastVerifyError)).toBe('used');
    httpMock.verify();
  });

  it("VerifyAdminToken classifies a 5xx as 'transient' (retryable)", async () => {
    const done = store.dispatch(new VerifyAdminToken('tok'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush(
        { code: 'INTERNAL_ERROR', message: 'boom' },
        { status: 500, statusText: 'Server Error' },
      );
    await done;

    expect(snapshot().lastVerifyError).toBe('transient');
    httpMock.verify();
  });

  it("VerifyAdminToken classifies an unknown/expired token as 'invalid'", async () => {
    const done = store.dispatch(new VerifyAdminToken('bad-token'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush(
        { code: 'UNAUTHENTICATED', message: 'invalid or expired' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await done;

    expect(snapshot().lastVerifyError).toBe('invalid');
    httpMock.verify();
  });

  it('VerifyAdminToken success resets lastVerifyError to null', async () => {
    const fail = store.dispatch(new VerifyAdminToken('bad-token'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'x' });
    await fail;
    expect(snapshot().lastVerifyError).toBe('invalid');

    const ok = store.dispatch(new VerifyAdminToken('magic-tok'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/verify'))
      .flush({
        authenticated: true,
        email: 'admin@example.com',
        sessionToken: 'sess-abc',
      });
    await ok;
    expect(snapshot().lastVerifyError).toBeNull();
    httpMock.verify();
  });

  it('LoginAdminWithPassword posts the trimmed payload and stores identity on success', async () => {
    const done = store.dispatch(
      new LoginAdminWithPassword('admin@example.com', 's3cret-password!', true),
    );
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/auth/login'),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      email: 'admin@example.com',
      password: 's3cret-password!',
      rememberMe: true,
    });
    req.flush({
      authenticated: true,
      user: {
        email: 'admin@example.com',
        name: 'Admin User',
        staffRole: 'super_admin',
      },
      sessionToken: 'sess-login-abc',
    });
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('authenticated');
    expect(s.sessionToken).toBe('sess-login-abc');
    expect(s.email).toBe('admin@example.com');
    expect(s.name).toBe('Admin User');
    expect(s.staffRole).toBe('super_admin');
    expect(s.sessionExpired).toBe(false);
    expect(s.lastLoginError).toBeNull();
    httpMock.verify();
  });

  it('LoginAdminWithPassword classifies 401 INVALID_CREDENTIALS and clears session', async () => {
    const done = store.dispatch(
      new LoginAdminWithPassword('admin@example.com', 'wrong', false),
    );
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/login'))
      .flush(
        { code: 'INVALID_CREDENTIALS', message: 'invalid credentials' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('unauthenticated');
    expect(s.sessionToken).toBeNull();
    expect(s.email).toBeNull();
    expect(s.name).toBeNull();
    expect(s.staffRole).toBeNull();
    expect(s.lastLoginError).toBe('invalid-credentials');
    httpMock.verify();
  });

  it('LoginAdminWithPassword classifies 429 TOO_MANY_ATTEMPTS', async () => {
    const done = store.dispatch(
      new LoginAdminWithPassword('admin@example.com', 'wrong', false),
    );
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/login'))
      .flush(
        { code: 'TOO_MANY_ATTEMPTS', message: 'rate limited' },
        { status: 429, statusText: 'Too Many Requests' },
      );
    await done;

    expect(snapshot().lastLoginError).toBe('rate-limited');
    httpMock.verify();
  });

  it('LoginAdminWithPassword classifies timeouts as transient', async () => {
    const done = store.dispatch(
      new LoginAdminWithPassword('admin@example.com', 'wrong', false),
    );
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/login'))
      .error(new ProgressEvent('timeout'), { status: 0 });
    await done;

    expect(snapshot().lastLoginError).toBe('transient');
    httpMock.verify();
  });

  it('LoginAdminWithPassword clears a previous error on retry and on success', async () => {
    const fail = store.dispatch(
      new LoginAdminWithPassword('admin@example.com', 'wrong', false),
    );
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/login'))
      .flush(
        { code: 'INVALID_CREDENTIALS' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await fail;
    expect(snapshot().lastLoginError).toBe('invalid-credentials');

    const ok = store.dispatch(
      new LoginAdminWithPassword('admin@example.com', 'right-password!', false),
    );
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/login'))
      .flush({
        authenticated: true,
        user: {
          email: 'admin@example.com',
          name: 'Admin User',
          staffRole: 'admin',
        },
        sessionToken: 'sess-retry-ok',
      });
    await ok;

    expect(snapshot().authStatus).toBe('authenticated');
    expect(snapshot().lastLoginError).toBeNull();
    httpMock.verify();
  });
});
