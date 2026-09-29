/**
 * Builder state tests (embed/09).
 *
 * Verifies: session verify/load transitions, tenant-scoped leads load +
 * summary, status updates (optimistic local apply + summary reconcile),
 * 403 cross-tenant handling, and logout clearing.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BuilderAuthMeResponse,
  BuilderLeadListResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  LoadBuilderLeads,
  LoadBuilderSession,
  LogoutBuilder,
  SetBuilderActiveOrg,
  UpdateBuilderLeadStatus,
} from './builder.actions';
import { BuilderEntraAuthService } from './builder-entra-auth.service';
import { BuilderState, type BuilderStateModel } from './builder.state';

const SESSION: BuilderAuthMeResponse = {
  authenticated: true,
  email: 'builder@example.com',
  tenantKey: 'elite-craft',
};

const LEADS_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Jane Homeowner',
      email: 'jane@example.com',
      phone: '403-555-0101',
      timeline: '3–6 months',
      leadScore: 82,
      status: 'new',
      statusUpdatedAt: '2026-09-20T10:00:00.000Z',
      addressKey: '123 Main St SW',
      projectType: 'new-build',
      createdAt: '2026-09-19T10:00:00.000Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Bob Buyer',
      email: 'bob@example.com',
      phone: null,
      timeline: 'ASAP',
      leadScore: 64,
      status: 'contacted',
      statusUpdatedAt: '2026-09-21T10:00:00.000Z',
      addressKey: '456 Oak Ave NW',
      projectType: 'reno',
      createdAt: '2026-09-18T10:00:00.000Z',
    },
  ],
  summary: { total: 2, new: 1, contacted: 1, quoted: 0, won: 0, lost: 0 },
};

describe('BuilderState (embed/09)', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  function snapshot(): BuilderStateModel {
    return store.selectSnapshot<BuilderStateModel>((state) => state.builder);
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([BuilderState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    TestBed.inject(ConfigService);
    store = TestBed.inject(Store);
  });

  it('starts unknown/unauthenticated with an empty pipeline', () => {
    const s = snapshot();
    expect(s.authStatus).toBe('unknown');
    expect(s.session).toBeNull();
    expect(s.leads).toEqual([]);
    expect(s.leadsStatus).toBe('idle');
  });

  it('LoadBuilderLeads stores leads and the summary', async () => {
    const done = store.dispatch(new LoadBuilderLeads());
    expect(snapshot().leadsStatus).toBe('loading');
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads'));
    expect(req.request.withCredentials).toBe(true);
    req.flush(LEADS_RESPONSE);
    await done;

    const s = snapshot();
    expect(s.leadsStatus).toBe('ready');
    expect(s.leads).toHaveLength(2);
    expect(s.summary).toEqual({
      total: 2,
      new: 1,
      contacted: 1,
      quoted: 0,
      won: 0,
      lost: 0,
    });
    httpMock.verify();
  });

  it('UpdateBuilderLeadStatus applies the transition and reconciles the summary', async () => {
    // Seed the pipeline first.
    const seed = store.dispatch(new LoadBuilderLeads());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads')).flush(LEADS_RESPONSE);
    await seed;

    const done = store.dispatch(
      new UpdateBuilderLeadStatus('11111111-1111-4111-8111-111111111111', 'won'),
    );
    expect(snapshot().updatingLeadId).toBe('11111111-1111-4111-8111-111111111111');
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/leads/11111111-1111-4111-8111-111111111111'),
    );
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ status: 'won' });
    req.flush({ ok: true });
    await done;

    const s = snapshot();
    expect(s.updatingLeadId).toBeNull();
    expect(s.updateError).toBeNull();
    expect(s.leads[0].status).toBe('won');
    // Summary reconciles: new 1→0, won 0→1, totals unchanged.
    expect(s.summary).toEqual({
      total: 2,
      new: 0,
      contacted: 1,
      quoted: 0,
      won: 1,
      lost: 0,
    });
    httpMock.verify();
  });

  it('UpdateBuilderLeadStatus surfaces a 403 as "forbidden" without mutating the lead', async () => {
    const seed = store.dispatch(new LoadBuilderLeads());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads')).flush(LEADS_RESPONSE);
    await seed;

    const done = store.dispatch(
      new UpdateBuilderLeadStatus('11111111-1111-4111-8111-111111111111', 'lost'),
    );
    const req = httpMock.expectOne((r) => r.url.includes('/api/v1/builder/leads/'));
    req.flush(
      { code: 'FORBIDDEN', message: 'Lead belongs to another tenant.' },
      { status: 403, statusText: 'Forbidden' },
    );
    await done;

    const s = snapshot();
    expect(s.updateError).toBe('forbidden');
    expect(s.updatingLeadId).toBeNull();
    expect(s.leads[0].status).toBe('new');
    httpMock.verify();
  });

  it('LogoutBuilder clears the session and pipeline', async () => {
    const probe = store.dispatch(new LoadBuilderSession());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/auth/me')).flush({
      ...SESSION,
      memberships: [],
    });
    await probe;

    const done = store.dispatch(new LogoutBuilder());
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/auth/logout'),
    );
    expect(req.request.method).toBe('POST');
    req.flush({ loggedOut: true, setCookie: 'cleared' });
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('unknown');
    expect(s.session).toBeNull();
    expect(s.sessionToken).toBeNull();
    expect(s.leads).toEqual([]);
    httpMock.verify();
  });

  it('LogoutBuilder fires the Entra end-session redirect with the id_token hint', async () => {
    const entraAuth = TestBed.inject(BuilderEntraAuthService);
    const redirectSpy = vi
      .spyOn(entraAuth, 'redirectToEntraLogout')
      .mockReturnValue(true);

    const done = store.dispatch(new LogoutBuilder());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/builder/auth/logout'))
      .flush({
        loggedOut: true,
        setCookie: 'cleared',
        entraLogoutUrl:
          'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/logout',
        entraIdTokenHint: 'builder-id-token',
      });
    await done;

    expect(redirectSpy).toHaveBeenCalledWith(
      'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/logout',
      'builder-id-token',
    );
    httpMock.verify();
  });

  it('LoadBuilderSession flags expired sessions for the login copy', async () => {
    const done = store.dispatch(new LoadBuilderSession());
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/auth/me'));
    req.flush(
      { code: 'SESSION_EXPIRED', message: 'expired' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await done;

    const s = snapshot();
    expect(s.authStatus).toBe('unauthenticated');
    expect(s.sessionExpired).toBe(true);
    httpMock.verify();
  });

  it('LoadBuilderSession preserves the active-org role when /me carries none', async () => {
    // Regression: /me always maps role:null, so a session probe after
    // sign-in must not wipe the builder_admin role set by
    // SetBuilderActiveOrg — otherwise the Team nav disappears.
    const seed = store.dispatch(new LoadBuilderSession());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/auth/me')).flush({
      ...SESSION,
      memberships: [],
    });
    await seed;

    store.dispatch(
      new SetBuilderActiveOrg('builder-1', 'Elite Craft Builders', 'builder_admin'),
    );
    expect(store.selectSnapshot(BuilderState.isBuilderAdmin)).toBe(true);

    const probe = store.dispatch(new LoadBuilderSession());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/auth/me')).flush({
      ...SESSION,
      memberships: [],
    });
    await probe;

    const s = snapshot();
    expect(s.session?.role).toBe('builder_admin');
    // /me maps builderId from the tenant key, so the non-null identity value
    // wins there; the null role/builderName fall back to the previous org.
    expect(s.session?.builderId).toBe('elite-craft');
    expect(s.session?.builderName).toBe('Elite Craft Builders');
    expect(store.selectSnapshot(BuilderState.isBuilderAdmin)).toBe(true);
    httpMock.verify();
  });
});
