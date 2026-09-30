import { Component, computed, DestroyRef, inject, input, OnInit, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import {
  BUILDER_COMMENT_THREAD_CONFIG,
  CommentThreadComponent,
  DEFAULT_COMMENT_THREAD_LABELS,
  sortCommentsByOldest,
} from '../../shared/components/comment-thread';
import type {
  Comment,
  CommentEdit,
  CommentPost,
  CommentThreadLabels,
} from '../../shared/components/comment-thread';
import { BUILDER_COPY } from './builder-copy';
import { BuilderCommentsApiService } from './builder-comments-api.service';
import { BuilderState } from './builder.state';

/**
 * Builder lead-comments container (BILL-06): mounts the shared
 * CommentThreadComponent on a lead card and wires its outputs to the
 * comments API.
 *
 * Thin by design — no NGXS state for the thread (ephemeral per-lead UI
 * state lives in signals here). Builder config hides every visibility
 * control: `{ allowPost: true, allowEdit: true, allowDelete: false,
 * showVisibilityToggle: false, showVisibilityBadges: false,
 * showAuthorBadges: true }` (shared admin notes carry the team badge).
 *
 * `currentUserId` is the session email — the only per-user identifier in
 * the frontend session. The BILL-05 backend sets the wire
 * `Comment.authorId` to the author's email (lowercased) so the "edit own
 * comment" affordance matches; authorship enforcement stays server-side on
 * the internal user id.
 */
@Component({
  selector: 'app-builder-lead-comments',
  standalone: true,
  imports: [CommentThreadComponent],
  templateUrl: './builder-lead-comments.component.html',
})
export class BuilderLeadCommentsComponent implements OnInit {
  private readonly api = inject(BuilderCommentsApiService);
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned, lazy-loaded with the portal). */
  protected readonly copy = inject(BUILDER_COPY);

  readonly leadId = input.required<string>();

  /**
   * The thread's current comments, emitted after the initial load and
   * after every successful post/edit. The lead card listens to keep its
   * notes count badge + latest-note preview live without a reload.
   */
  readonly commentsChanged = output<readonly Comment[]>();

  protected readonly threadConfig = BUILDER_COMMENT_THREAD_CONFIG;

  protected readonly comments = signal<readonly Comment[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** Session email — see the coordination note above. */
  protected readonly currentUserId = computed(
    () => this.store.selectSignal(BuilderState.session)()?.email ?? '',
  );

  /** Component defaults with builder voice for the empty state + team badge. */
  protected readonly labels = computed<CommentThreadLabels>(() => ({
    ...DEFAULT_COMMENT_THREAD_LABELS,
    emptyThread: this.copy.commentsEmpty,
    adminAuthorBadgeLabel: this.copy.commentsTeamBadge,
  }));

  ngOnInit(): void {
    this.reload();
  }

  /** Publish the thread so the lead card's badge/preview stays live. */
  private emitChanged(comments: readonly Comment[]): void {
    this.commentsChanged.emit(comments);
  }

  protected onPost(event: CommentPost): void {
    this.error.set(null);
    this.api
      .postComment(this.leadId(), event.body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (comment) =>
          this.comments.update((all) => {
            const next = sortCommentsByOldest([...all, comment]);
            this.emitChanged(next);
            return next;
          }),
        error: () => this.error.set(this.copy.commentsPostFailed),
      });
  }

  protected onEdit(event: CommentEdit): void {
    this.error.set(null);
    this.api
      .editComment(event.id, event.body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) =>
          this.comments.update((all) => {
            const next = all.map((c) => (c.id === updated.id ? updated : c));
            this.emitChanged(next);
            return next;
          }),
        error: () => this.error.set(this.copy.commentsEditFailed),
      });
  }

  private reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .listComments(this.leadId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          const comments = sortCommentsByOldest(response.comments);
          this.comments.set(comments);
          this.loading.set(false);
          this.emitChanged(comments);
        },
        error: () => {
          this.loading.set(false);
          this.error.set(this.copy.commentsPostFailed);
        },
      });
  }
}
