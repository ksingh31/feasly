/**
 * Admin auth state tests (auth/02).
 *
 * Verifies: session bootstrap via CompleteEntraSignIn (Entra is the only
 * admin sign-in since the magic-link flow was retired 2026-09-28),
 * LoadAdminSession transitions (token kept on success, cleared on
 * failure), expired-session flagging for the login copy, logout clearing,
 * and FailEntraSignIn callback-failure classification for the callback
 * page copy.
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
} from './admin-auth.actions';
import { AdminAuthState, type AdminAuthStateModel } from './admin-auth.state';

describe('AdminAuthState (auth/02)', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  function snapshot(): AdminAuthStateModel {
    return store.selectSnapshot<AdminAuthStateModel>(
      (state) => state.adminAuth,
    );
  }

  /** Bootstrap an authenticated session the way Entra sign-in does. */
  async function signIn(): Promise<void> {
    await store.dispatch(
      new CompleteEntraSignIn(
        'sess-entra-abc',
        'admin@example.com',
        'Admin User',
        'super_admin',
      ),
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

  it('CompleteEntraSignIn bootstraps the session identity', async () => {
    await signIn();

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

  it('LoadAdminSession re-authenticates without dropping the stored token', async () => {
    await signIn();

    const done = store.dispatch(new LoadAdminSession());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/auth/me'))
      .flush({ authenticated: true, email: 'admin@example.com' });
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('authenticated');
    expect(s.sessionToken).toBe('sess-entra-abc');
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
    await signIn();

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
    await signIn();

    await store.dispatch(new ClearAdminAuth());
    const s = snapshot();
    expect(s.sessionToken).toBeNull();
    expect(s.authStatus).toBe('unknown');
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
