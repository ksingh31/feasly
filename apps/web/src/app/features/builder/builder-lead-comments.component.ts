import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
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
 * showVisibilityToggle: false, showVisibilityBadges: false }`.
 *
 * `currentUserId` is the session email — the only per-user identifier in
 * the frontend session. COORDINATION POINT (BILL-05): the backend must set
 * `Comment.authorId` to the same value for the "edit own comment"
 * affordance to match.
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

  protected readonly threadConfig = BUILDER_COMMENT_THREAD_CONFIG;

  protected readonly comments = signal<readonly Comment[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** Session email — see the coordination note above. */
  protected readonly currentUserId = computed(
    () => this.store.selectSignal(BuilderState.session)()?.email ?? '',
  );

  /** Component defaults with builder voice for the empty state. */
  protected readonly labels = computed<CommentThreadLabels>(() => ({
    ...DEFAULT_COMMENT_THREAD_LABELS,
    emptyThread: this.copy.commentsEmpty,
  }));

  ngOnInit(): void {
    this.reload();
  }

  protected onPost(event: CommentPost): void {
    this.error.set(null);
    this.api
      .postComment(this.leadId(), event.body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (comment) =>
          this.comments.update((all) => sortCommentsByOldest([...all, comment])),
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
          this.comments.update((all) => all.map((c) => (c.id === updated.id ? updated : c))),
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
          this.comments.set(sortCommentsByOldest(response.comments));
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.error.set(this.copy.commentsPostFailed);
        },
      });
  }
}
