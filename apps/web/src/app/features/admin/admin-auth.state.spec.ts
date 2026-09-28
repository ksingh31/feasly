/**
 * Admin auth state tests (admin/01 + auth/02 pivot).
 *
 * Verifies: token verify/load transitions (bearer token stored on
 * success, cleared on failure/logout), expired-session flagging for the
 * login copy, logout clearing, and the auth/02 Entra actions
 * (CompleteEntraSignIn bootstraps the session identity; FailEntraSignIn
 * classifies the callback failure for the callback page copy).
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
  CompleteEntraSignIn,
  FailEntraSignIn,
  LoadAdminSession,
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

  it('CompleteEntraSignIn bootstraps the session identity', async () => {
    await store.dispatch(
      new CompleteEntraSignIn(
        'sess-entra-abc',
        'admin@example.com',
        'Admin User',
        'super_admin',
      ),
    );

    const s = snapshot();
    expect(s.authStatus).toBe('authenticated');
    expect(s.sessionToken).toBe('sess-entra-abc');
    expect(s.email).toBe('admin@example.com');
    expect(s.name).toBe('Admin User');
    expect(s.staffRole).toBe('super_admin');
    expect(s.sessionExpired).toBe(false);
    expect(s.lastEntraError).toBeNull();
    expect(store.selectSnapshot(AdminAuthState.authenticated)).toBe(true);
    httpMock.verify();
  });

  it('CompleteEntraSignIn clears a previous callback error', async () => {
    await store.dispatch(new FailEntraSignIn('transient'));
    expect(snapshot().lastEntraError).toBe('transient');

    await store.dispatch(
      new CompleteEntraSignIn('sess-entra-ok', 'a@b.c', 'A B', 'admin'),
    );
    expect(snapshot().lastEntraError).toBeNull();
    httpMock.verify();
  });

  it('FailEntraSignIn records the classified error and clears the session', async () => {
    await store.dispatch(
      new CompleteEntraSignIn('sess-entra-abc', 'a@b.c', 'A B', 'viewer'),
    );
    await store.dispatch(new FailEntraSignIn('state-mismatch'));

    const s = snapshot();
    expect(s.authStatus).toBe('unauthenticated');
    expect(s.sessionToken).toBeNull();
    expect(s.email).toBeNull();
    expect(s.name).toBeNull();
    expect(s.staffRole).toBeNull();
    expect(s.lastEntraError).toBe('state-mismatch');
    expect(store.selectSnapshot(AdminAuthState.lastEntraError)).toBe(
      'state-mismatch',
    );
    httpMock.verify();
  });

  it('FailEntraSignIn supports the cancelled and transient kinds', async () => {
    await store.dispatch(new FailEntraSignIn('cancelled'));
    expect(snapshot().lastEntraError).toBe('cancelled');
    await store.dispatch(new FailEntraSignIn('transient'));
    expect(snapshot().lastEntraError).toBe('transient');
    httpMock.verify();
  });
});
