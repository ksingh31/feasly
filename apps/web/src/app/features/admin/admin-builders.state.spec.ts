import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import {
  AssignLeadBuilder,
  CreateBuilder,
  DismissAssignBuilderError,
  DismissAssignBuilderSuccess,
  DismissBuildersSaveError,
  DismissBuildersSaved,
  LoadBuilders,
  UpdateBuilder,
} from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import type { Builder } from '@feasly/contracts';

const BUILDER_A: Builder = {
  id: 'b1',
  tenantKey: 'elite-craft',
  businessName: 'Elite Craft Builders',
  displayName: 'Elite Craft',
  email: 'hello@elite.example',
  phone: null,
  logoUrl: null,
  accentColor: '#C8A24B',
  allowedOrigins: ['elite.example'],
  plan: 'flat',
  status: 'active',
  settings: {},
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

const BUILDER_B: Builder = {
  ...BUILDER_A,
  id: 'b2',
  tenantKey: 'north-homes',
  businessName: 'North Homes Ltd',
  displayName: 'North Homes',
  plan: null,
  status: 'inactive',
};

/**
 * AdminBuildersState (embed/02 admin-UI migration): builders table load,
 * create/update with saved + error states, lead assignment.
 */
describe('AdminBuildersState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        provideStore([AdminBuildersState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
  }

  beforeEach(async () => {
    await setup();
  });

  it('loads the builders table', async () => {
    const done = store.dispatch(new LoadBuilders());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders'))
      .flush({ builders: [BUILDER_A, BUILDER_B] });
    await done.toPromise();

    expect(store.selectSnapshot(AdminBuildersState.builders)).toEqual([BUILDER_A, BUILDER_B]);
    expect(store.selectSnapshot(AdminBuildersState.listStatus)).toBe('idle');
    expect(store.selectSnapshot(AdminBuildersState.listError)).toBeNull();
  });

  it('stores the load error on failure', async () => {
    const done = store.dispatch(new LoadBuilders());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminBuildersState.listStatus)).toBe('error');
    expect(store.selectSnapshot(AdminBuildersState.listError)).not.toBeNull();
    expect(store.selectSnapshot(AdminBuildersState.builders)).toEqual([]);
  });

  it('appends the created builder and marks it saved', async () => {
    let done = store.dispatch(new LoadBuilders());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders'))
      .flush({ builders: [BUILDER_A] });
    await done.toPromise();

    done = store.dispatch(
      new CreateBuilder({
        tenantKey: 'north-homes',
        businessName: 'North Homes Ltd',
        displayName: 'North Homes',
      }),
    );
    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'POST',
    );
    expect(req.request.body).toMatchObject({ tenantKey: 'north-homes' });
    req.flush(BUILDER_B);
    await done.toPromise();

    expect(store.selectSnapshot(AdminBuildersState.builders)).toEqual([BUILDER_A, BUILDER_B]);
    expect(store.selectSnapshot(AdminBuildersState.saved)).toBe(true);
    expect(store.selectSnapshot(AdminBuildersState.saving)).toBe(false);
    expect(store.selectSnapshot(AdminBuildersState.saveError)).toBeNull();

    store.dispatch(new DismissBuildersSaved());
    expect(store.selectSnapshot(AdminBuildersState.saved)).toBe(false);
  });

  it('stores the save error when creation fails', async () => {
    const done = store.dispatch(new CreateBuilder({ tenantKey: 'x', businessName: 'X', displayName: 'X' }));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'POST')
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminBuildersState.saving)).toBe(false);
    expect(store.selectSnapshot(AdminBuildersState.saved)).toBe(false);
    expect(store.selectSnapshot(AdminBuildersState.saveError)).not.toBeNull();
    expect(store.selectSnapshot(AdminBuildersState.builders)).toEqual([]);

    store.dispatch(new DismissBuildersSaveError());
    expect(store.selectSnapshot(AdminBuildersState.saveError)).toBeNull();
  });

  it('replaces the updated builder in place', async () => {
    let done = store.dispatch(new LoadBuilders());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders'))
      .flush({ builders: [BUILDER_A, BUILDER_B] });
    await done.toPromise();

    done = store.dispatch(new UpdateBuilder('b1', { displayName: 'Elite Craft Homes' }));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ displayName: 'Elite Craft Homes' });
    const updated = { ...BUILDER_A, displayName: 'Elite Craft Homes' };
    req.flush(updated);
    await done.toPromise();

    expect(store.selectSnapshot(AdminBuildersState.builders)).toEqual([updated, BUILDER_B]);
    expect(store.selectSnapshot(AdminBuildersState.saved)).toBe(true);
  });

  it('assigns a lead to a builder and unassigns with null', async () => {
    let done = store.dispatch(new AssignLeadBuilder('lead-1', 'b1'));
    let req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/leads/lead-1/assign-builder'),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ builderId: 'b1' });
    req.flush({ ok: true });
    await done.toPromise();

    expect(store.selectSnapshot(AdminBuildersState.assigning)).toBe(false);
    expect(store.selectSnapshot(AdminBuildersState.assignError)).toBeNull();

    done = store.dispatch(new AssignLeadBuilder('lead-1', null));
    req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/leads/lead-1/assign-builder'),
    );
    expect(req.request.body).toEqual({ builderId: null });
    req.flush({ ok: true });
    await done.toPromise();

    expect(store.selectSnapshot(AdminBuildersState.assigning)).toBe(false);
  });

  it('stores the assign error on failure', async () => {
    const done = store.dispatch(new AssignLeadBuilder('lead-1', 'b1'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1/assign-builder'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminBuildersState.assigning)).toBe(false);
    expect(store.selectSnapshot(AdminBuildersState.assignError)).not.toBeNull();

    store.dispatch(new DismissAssignBuilderError());
    expect(store.selectSnapshot(AdminBuildersState.assignError)).toBeNull();
  });

  it('sets assignSuccess on success and clears it on dismiss or a new attempt', async () => {
    let done = store.dispatch(new AssignLeadBuilder('lead-1', 'b1'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1/assign-builder'))
      .flush({ ok: true });
    await done.toPromise();

    expect(store.selectSnapshot(AdminBuildersState.assignSuccess)).toBe(true);

    store.dispatch(new DismissAssignBuilderSuccess());
    expect(store.selectSnapshot(AdminBuildersState.assignSuccess)).toBe(false);

    // A new attempt also clears a stale confirmation.
    done = store.dispatch(new AssignLeadBuilder('lead-1', 'b1'));
    expect(store.selectSnapshot(AdminBuildersState.assignSuccess)).toBe(false);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1/assign-builder'))
      .flush({ ok: true });
    await done.toPromise();
    expect(store.selectSnapshot(AdminBuildersState.assignSuccess)).toBe(true);
  });
});
