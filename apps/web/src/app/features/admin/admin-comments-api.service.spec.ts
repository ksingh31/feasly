/**
 * AdminCommentsApiService tests (BILL-07).
 *
 * Asserts the service speaks the BILL-05 frozen admin routes with the
 * right method, URL, body, and credentials — typed against
 * `@feasly/contracts`.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminCommentsApiService } from './admin-comments-api.service';
import type { Comment } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const COMMENT: Comment = {
  id: 'c-1',
  entityType: 'lead',
  entityId: 'lead-1',
  authorKind: 'admin',
  authorId: 'admin-1',
  authorDisplayName: 'Priya (platform)',
  visibility: 'admin_only',
  body: 'Watch this one.',
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z',
  edited: false,
  deletedAt: null,
};

describe('AdminCommentsApiService', () => {
  let service: AdminCommentsApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ConfigService,
          useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] },
        },
      ],
    });
    service = TestBed.inject(AdminCommentsApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('lists comments from the admin lead-comments endpoint', () => {
    let result: readonly Comment[] | null = null;
    service.listComments('lead-1').subscribe((res) => {
      result = res.comments;
    });
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1/comments'));
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ comments: [COMMENT] });
    expect(result).toEqual([COMMENT]);
  });

  it('posts with the chosen visibility', () => {
    service.postComment('lead-1', 'Hello builder', 'org').subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/lead-1/comments'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ body: 'Hello builder', visibility: 'org' });
    expect(req.request.withCredentials).toBe(true);
    req.flush(COMMENT);
  });

  it('edits a comment by id', () => {
    service.editComment('c-1', 'Updated').subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/comments/c-1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ body: 'Updated' });
    req.flush({ ...COMMENT, body: 'Updated', edited: true });
  });

  it('deletes a comment by id', () => {
    let done = false;
    service.deleteComment('c-1').subscribe(() => {
      done = true;
    });
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/comments/c-1'));
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
    expect(done).toBe(true);
  });
});
