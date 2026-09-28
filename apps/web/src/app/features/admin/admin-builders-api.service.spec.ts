import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Builder } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AdminBuildersApiService } from './admin-builders-api.service';

const BUILDER: Builder = {
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

/**
 * AdminBuildersApiService (embed/02 admin-UI migration): endpoint wiring
 * for the builders table + the lead assign-builder endpoint.
 */
describe('AdminBuildersApiService', () => {
  let service: AdminBuildersApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ConfigService],
    });
    service = TestBed.inject(AdminBuildersApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('lists builders from the builders-table endpoint', () => {
    service.listBuilders().subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders'));
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ builders: [BUILDER] });
  });

  it('fetches a single builder by id', () => {
    service.getBuilder('b1').subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush(BUILDER);
  });

  it('creates a builder with the given body', () => {
    const body = {
      tenantKey: 'elite-craft',
      businessName: 'Elite Craft Builders',
      displayName: 'Elite Craft',
    };
    service.createBuilder(body).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(body);
    expect(req.request.withCredentials).toBe(true);
    req.flush(BUILDER);
  });

  it('updates a builder by id', () => {
    const body = { displayName: 'Elite Craft Homes' };
    service.updateBuilder('b1', body).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual(body);
    expect(req.request.withCredentials).toBe(true);
    req.flush({ ...BUILDER, ...body });
  });

  it('assigns a lead to a builder via the assign-builder endpoint', () => {
    service.assignLeadBuilder('lead-1', 'b1').subscribe();
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/leads/lead-1/assign-builder'),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ builderId: 'b1' });
    expect(req.request.withCredentials).toBe(true);
    req.flush({ ok: true });
  });

  it('unassigns a lead with a null builderId', () => {
    service.assignLeadBuilder('lead-1', null).subscribe();
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/leads/lead-1/assign-builder'),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ builderId: null });
    req.flush({ ok: true });
  });
});
