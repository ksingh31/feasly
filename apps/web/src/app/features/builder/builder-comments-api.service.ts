import { inject, Injectable } from '@angular/core';
import { of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { Store } from '@ngxs/store';
import type {
  Comment,
  CommentListResponse,
} from '../../shared/components/comment-thread';
import { BuilderState } from './builder.state';

/**
 * Builder lead-comments API client (BILL-06).
 *
 * TEMPORARY IN-MEMORY MOCK of the frozen BILL-05 contract — the real
 * backend (`GET/POST /api/v1/builder/leads/{leadId}/comments`,
 * `PATCH /api/v1/builder/comments/{commentId}`) is being built in parallel
 * (story/bill-05-comments-api). When it merges, replace the bodies below
 * with HttpClient calls against the frozen shapes; the container and the
 * shared thread component are already wired to those shapes and must not
 * change.
 *
 * Frozen contract:
 * - `GET /api/v1/builder/leads/{leadId}/comments` → `{ comments: Comment[] }`
 * - `POST /api/v1/builder/leads/{leadId}/comments` `{ body }` → `Comment`
 * - `PATCH /api/v1/builder/comments/{commentId}` `{ body }` → `Comment`
 * - `Comment` = `{ id, entityType, entityId, authorKind, authorId,
 *   authorDisplayName, visibility, body, createdAt, updatedAt, edited }`.
 */
@Injectable({ providedIn: 'root' })
export class BuilderCommentsApiService {
  private readonly store = inject(Store);

  /** In-memory threads keyed by lead id (mock persistence for the session). */
  private readonly threads = new Map<string, Comment[]>();

  /** Tenant-scoped comment thread for a lead, oldest first. */
  listComments(leadId: string): Observable<CommentListResponse> {
    return of({ comments: this.threadFor(leadId) });
  }

  /**
   * Post a note as the current builder user. The real backend derives the
   * author from the session and forces `visibility: 'org'`; the mock does
   * the same from the NGXS session.
   */
  postComment(leadId: string, body: string): Observable<Comment> {
    const session = this.store.selectSnapshot(BuilderState.session);
    const now = new Date().toISOString();
    const comment: Comment = {
      id: crypto.randomUUID(),
      entityType: 'lead',
      entityId: leadId,
      authorKind: 'builder',
      authorId: session?.email ?? 'unknown',
      authorDisplayName: session?.name ?? session?.email ?? 'A builder',
      visibility: 'org',
      body,
      createdAt: now,
      updatedAt: now,
      edited: false,
    };
    this.threadFor(leadId).push(comment);
    return of(comment);
  }

  /** Edit an own comment (author-only is enforced server-side for real). */
  editComment(commentId: string, body: string): Observable<Comment> {
    for (const thread of this.threads.values()) {
      const index = thread.findIndex((c) => c.id === commentId);
      if (index !== -1) {
        const updated: Comment = {
          ...thread[index],
          body,
          updatedAt: new Date().toISOString(),
          edited: true,
        };
        thread[index] = updated;
        return of(updated);
      }
    }
    return throwError(() => new Error(`Comment not found: ${commentId}`));
  }

  private threadFor(leadId: string): Comment[] {
    let thread = this.threads.get(leadId);
    if (!thread) {
      thread = [];
      this.threads.set(leadId, thread);
    }
    return thread;
  }
}
