import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { AdminLeadsApiService } from './admin-leads-api.service';

/**
 * AdminLeadsApiService (admin/02): query-param mapping and endpoint wiring.
 */
describe('AdminLeadsApiService', () => {
  let service: AdminLeadsApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ConfigService],
    });
    service = TestBed.inject(AdminLeadsApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('maps every filter to its backend query param name', () => {
    const params = service.toQueryParams(
      {
        minScore: 50,
        maxScore: 90,
        status: 'contacted',
        source: 'embed',
        projectType: 'renovation',
        tenantId: 'elite-craft',
        createdAfter: '2026-09-01T00:00:00.000Z',
        createdBefore: '2026-09-25T23:59:59.999Z',
        search: 'beltline',
        includeQuarantined: true,
        includeSandbox: true,
      },
      'cursor-abc',
      25,
    );
    expect(params.get('minScore')).toBe('50');
    expect(params.get('maxScore')).toBe('90');
    expect(params.get('status')).toBe('contacted');
    expect(params.get('source')).toBe('embed');
    expect(params.get('projectType')).toBe('renovation');
    expect(params.get('tenantId')).toBe('elite-craft');
    expect(params.get('createdAfter')).toBe('2026-09-01T00:00:00.000Z');
    expect(params.get('createdBefore')).toBe('2026-09-25T23:59:59.999Z');
    expect(params.get('search')).toBe('beltline');
    expect(params.get('includeQuarantined')).toBe('true');
    expect(params.get('includeSandbox')).toBe('true');
    expect(params.get('cursor')).toBe('cursor-abc');
    expect(params.get('limit')).toBe('25');
  });

  it('omits undefined/empty filters so backend defaults apply', () => {
    const params = service.toQueryParams({});
    expect(params.keys().length).toBe(0);
  });

  it('lists leads with credentials and the admin cookie', () => {
    service.listLeads({ status: 'new' }).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('status')).toBe('new');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ leads: [], nextCursor: null, totalCount: 0 });
  });

  it('fetches lead detail by id', () => {
    service.getLead('lead-1').subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1'));
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ id: 'lead-1' });
  });

  it('posts notes and patches status', () => {
    service.addNote('lead-1', 'Called twice.').subscribe();
    const noteReq = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1/notes'));
    expect(noteReq.request.method).toBe('POST');
    expect(noteReq.request.body).toEqual({ note: 'Called twice.' });
    noteReq.flush({ ok: true });

    service.updateStatus('lead-1', 'won').subscribe();
    const statusReq = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1/status'));
    expect(statusReq.request.method).toBe('PATCH');
    expect(statusReq.request.body).toEqual({ status: 'won' });
    statusReq.flush({ ok: true });
  });

  it('requests the CSV export as a blob with the active filters', () => {
    service.exportCsv({ source: 'web' }).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/export.csv'));
    expect(req.request.method).toBe('GET');
    expect(req.request.responseType).toBe('blob');
    expect(req.request.params.get('source')).toBe('web');
    expect(req.request.withCredentials).toBe(true);
    req.flush(new Blob(['a,b'], { type: 'text/csv' }));
  });
});
