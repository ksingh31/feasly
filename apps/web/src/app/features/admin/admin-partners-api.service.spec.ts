import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminBuilderPartner } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AdminPartnersApiService } from './admin-partners-api.service';

const PARTNER: AdminBuilderPartner = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Elite Craft Builders',
  logoUrl: null,
  websiteUrl: 'https://elitecraftbuilders.com',
  description: null,
  builderId: null,
  displayOrder: 0,
  active: true,
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
};

/** AdminPartnersApiService (#919): wiring for the #896 admin partner API. */
describe('AdminPartnersApiService', () => {
  let service: AdminPartnersApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ConfigService],
    });
    service = TestBed.inject(AdminPartnersApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('lists every partner with the admin session cookie', () => {
    let partners: readonly AdminBuilderPartner[] = [];
    service.listPartners().subscribe((res) => (partners = res.partners));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/partners'));
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ partners: [PARTNER] });
    expect(partners).toEqual([PARTNER]);
  });

  it('adds a partner with POST', () => {
    service.createPartner({ name: 'North Homes', websiteUrl: 'https://north.example' }).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/partners'));
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.body).toEqual({ name: 'North Homes', websiteUrl: 'https://north.example' });
    req.flush({ ...PARTNER, name: 'North Homes' });
  });

  it('edits, deactivates or reorders a partner with PATCH /{id}', () => {
    service.updatePartner(PARTNER.id, { active: false, displayOrder: 3 }).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith(`/api/v1/admin/partners/${PARTNER.id}`));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.body).toEqual({ active: false, displayOrder: 3 });
    req.flush({ ...PARTNER, active: false, displayOrder: 3 });
  });

  it('maps a backend problem onto the ApiError envelope', () => {
    let error: { code?: string; message?: string } | null = null;
    service.updatePartner(PARTNER.id, { websiteUrl: 'http://x' }).subscribe({
      error: (e: { code?: string; message?: string }) => (error = e),
    });
    httpMock
      .expectOne((r) => r.url.endsWith(`/api/v1/admin/partners/${PARTNER.id}`))
      .flush(
        { code: 'validation_failed', message: 'websiteUrl must be an https URL.' },
        { status: 400, statusText: 'Bad Request' },
      );
    expect(error).toMatchObject({ code: 'validation_failed', message: 'websiteUrl must be an https URL.' });
  });
});
