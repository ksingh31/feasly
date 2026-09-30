import { Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { AdminAuthState } from './admin-auth.state';
import { AdminCommentsApiService } from './admin-comments-api.service';
import type { Comment } from '@feasly/contracts';
import {
  CommentThreadComponent,
  sortCommentsByOldest,
  type CommentEdit,
  type CommentPost,
  type CommentThreadConfig,
} from '../../shared/components/comment-thread';

/**
 * Admin lead-comments container (BILL-07).
 *
 * Thin by design: all presentation lives in the shared `comment-thread`
 * component (owned by BILL-06); this container only wires its outputs to
 * the admin comments API and owns the loading/error state.
 *
 * Admin config: post + edit + delete, visibility toggle on the composer
 * (defaulting to Internal only — the safe default), visibility badges on
 * internal notes. The toggle choice flows through the `post` event's
 * `visibility` field; when absent we fall back to `admin_only`.
 */
@Component({
  selector: 'app-admin-lead-comments',
  standalone: true,
  imports: [CommentThreadComponent],
  templateUrl: './admin-lead-comments.component.html',
  styleUrls: ['./admin-lead-comments.component.scss'],
})
export class AdminLeadCommentsComponent implements OnInit {
  /** Lead whose comments this thread shows. */
  readonly leadId = input.required<string>();

  private readonly api = inject(AdminCommentsApiService);
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  /** Admin config — everything on, incl. the visibility toggle + badges. */
  protected readonly config: CommentThreadConfig = {
    allowPost: true,
    allowEdit: true,
    allowDelete: true,
    showVisibilityToggle: true,
    showVisibilityBadges: true,
    // The "Feasly team" badge is a builder-portal affordance — the admin
    // console already distinguishes authorship and stays unchanged.
    showAuthorBadges: false,
  };

  protected readonly comments = signal<readonly Comment[]>([]);
  protected readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | null>(null);

  /**
   * Best stable admin identifier available on the frontend (the admin
   * identity carries email + display name, no uuid). Drives the thread's
   * "own comment" affordance — the wire `Comment.authorId` is the author's
   * email (lowercased), matching the BILL-05 backend. Edit stays
   * author-only for admins too (the backend 403s edits of other people's
   * comments); admins moderate via soft-delete.
   */
  protected currentUserId(): string {
    return this.store.selectSnapshot(AdminAuthState.email) ?? '';
  }

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.status.set('loading');
    this.error.set(null);
    this.actionError.set(null);
    this.api
      .listComments(this.leadId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.comments.set(sortCommentsByOldest(res.comments));
          this.status.set('ready');
        },
        error: (err: unknown) => {
          this.error.set(err instanceof Error ? err.message : 'Could not load comments.');
          this.status.set('error');
        },
      });
  }

  protected onPost(event: CommentPost): void {
    // Safe default: internal-only when the event carries no choice.
    const visibility = event.visibility ?? 'admin_only';
    this.busy.set(true);
    this.actionError.set(null);
    this.api
      .postComment(this.leadId(), event.body, visibility)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (comment) => {
          this.comments.update((list) => sortCommentsByOldest([...list, comment]));
          this.busy.set(false);
        },
        error: (err: unknown) => {
          this.actionError.set(err instanceof Error ? err.message : 'Could not post the comment.');
          this.busy.set(false);
        },
      });
  }

  protected onEdit(event: CommentEdit): void {
    this.actionError.set(null);
    this.api
      .editComment(event.id, event.body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.comments.update((list) => list.map((c) => (c.id === updated.id ? updated : c)));
        },
        error: (err: unknown) => {
          this.actionError.set(err instanceof Error ? err.message : 'Could not save the edit.');
        },
      });
  }

  protected onDelete(id: string): void {
    this.actionError.set(null);
    this.api
      .deleteComment(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.comments.update((list) => list.filter((c) => c.id !== id));
        },
        error: (err: unknown) => {
          this.actionError.set(err instanceof Error ? err.message : 'Could not delete the comment.');
        },
      });
  }
}
