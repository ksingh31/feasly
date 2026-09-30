/**
 * BuilderCommentsApiService tests (BILL-06 follow-up: real backend wiring).
 *
 * Asserts the service speaks the BILL-05 frozen builder routes with the
 * right method, URL, body, and credentials — typed against
 * `@feasly/contracts`. The builder path never sends `visibility` (the
 * backend forces `org` server-side) and exposes no delete.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { BuilderCommentsApiService } from './builder-comments-api.service';
import type { Comment } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const COMMENT: Comment = {
  id: 'c-1',
  entityType: 'lead',
  entityId: 'lead-1',
  authorKind: 'builder',
  authorId: 'builder@example.com',
  authorDisplayName: 'A Builder',
  visibility: 'org',
  body: 'Existing note.',
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z',
  edited: false,
  deletedAt: null,
};

describe('BuilderCommentsApiService', () => {
  let service: BuilderCommentsApiService;
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
    service = TestBed.inject(BuilderCommentsApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('lists comments from the builder lead-comments endpoint', () => {
    let result: readonly Comment[] | null = null;
    service.listComments('lead-1').subscribe((res) => {
      result = res.comments;
    });
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads/lead-1/comments'));
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ comments: [COMMENT] });
    expect(result).toEqual([COMMENT]);
  });

  it('posts without a visibility field (backend forces org)', () => {
    service.postComment('lead-1', 'Hello admin').subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads/lead-1/comments'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ body: 'Hello admin' });
    expect('visibility' in (req.request.body as object)).toBe(false);
    expect(req.request.withCredentials).toBe(true);
    req.flush(COMMENT);
  });

  it('edits a comment by id', () => {
    service.editComment('c-1', 'Updated').subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/comments/c-1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ body: 'Updated' });
    req.flush({ ...COMMENT, body: 'Updated', edited: true });
  });

  it('exposes no delete operation for builders', () => {
    expect('deleteComment' in service).toBe(false);
  });
});
