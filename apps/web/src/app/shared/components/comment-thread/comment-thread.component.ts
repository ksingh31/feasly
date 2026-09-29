import { Component, computed, effect, input, output, signal } from '@angular/core';
import type {
  Comment,
  CommentEditEvent,
  CommentPostEvent,
  CommentThreadConfig,
  CommentThreadLabels,
} from './comment-thread.models';
import {
  DEFAULT_COMMENT_THREAD_LABELS,
  formatCommentTimestamp,
} from './comment-thread.models';

/** A mutation the component emitted and is waiting on the container to resolve. */
interface PendingOp {
  readonly op: 'post' | 'edit' | 'delete';
  /** The comments reference at emit time — resolution needs a NEW reference. */
  readonly baseline: readonly Comment[];
}

/**
 * Shared lead-comment thread (BILL-06): presentational only — zero API
 * calls. Driven by inputs, reports user intent through outputs; the
 * portal container owns fetching and mutation.
 *
 * Async contract with the container: on post/edit/delete the component
 * records a pending op and disables the relevant form. The container
 * resolves it by EITHER publishing a new `comments` array (success — the
 * component clears drafts and exits edit mode) OR setting `error`
 * (failure — drafts are kept so nothing the user typed is lost).
 */
@Component({
  selector: 'app-comment-thread',
  standalone: true,
  templateUrl: './comment-thread.component.html',
  styleUrl: './comment-thread.component.scss',
})
export class CommentThreadComponent {
  private static nextId = 0;

  readonly comments = input.required<readonly Comment[]>();
  readonly currentUserId = input.required<string>();
  readonly config = input.required<CommentThreadConfig>();
  readonly maxLength = input.required<number>();
  /** Initial fetch in flight. */
  readonly loading = input(false);
  /** Container-reported failure; shown until dismissed. */
  readonly error = input<string | null>(null);
  readonly labels = input<CommentThreadLabels>(DEFAULT_COMMENT_THREAD_LABELS);

  readonly post = output<CommentPostEvent>();
  readonly edit = output<CommentEditEvent>();
  readonly delete = output<string>();
  readonly dismissError = output<void>();

  /** Unique ids per instance (several threads can share a page). */
  protected readonly composerId = `comment-thread-composer-${++CommentThreadComponent.nextId}`;
  protected readonly visibilityId = `comment-thread-visibility-${CommentThreadComponent.nextId}`;

  protected readonly draft = signal('');
  protected readonly postVisibility = signal<'org' | 'admin_only'>('org');
  protected readonly editId = signal<string | null>(null);
  protected readonly editDraft = signal('');
  protected readonly deleteConfirmId = signal<string | null>(null);
  protected readonly pendingOp = signal<PendingOp | null>(null);

  protected readonly remaining = computed(() => this.maxLength() - this.draft().length);
  protected readonly charHint = computed(
    () =>
      `${this.maxLength().toLocaleString('en-CA')} ${this.labels().charactersMaxSuffix}`,
  );
  protected readonly busy = computed(() => this.pendingOp() !== null);
  protected readonly posting = computed(
    () => this.pendingOp()?.op === 'post',
  );

  constructor() {
    // Success: the container published a new comments array while an op
    // was pending → clear drafts, exit edit mode, re-arm.
    effect(() => {
      const current = this.comments();
      const pending = this.pendingOp();
      if (pending !== null && this.error() === null && current !== pending.baseline) {
        if (pending.op === 'post') {
          this.draft.set('');
          this.postVisibility.set('org');
        }
        if (pending.op === 'edit') {
          this.editId.set(null);
          this.editDraft.set('');
        }
        if (pending.op === 'delete') {
          this.deleteConfirmId.set(null);
        }
        this.pendingOp.set(null);
      }
    });
    // Failure: the container reported an error → re-arm, keep drafts.
    effect(() => {
      if (this.error() !== null && this.pendingOp() !== null) {
        this.pendingOp.set(null);
      }
    });
  }

  protected formatTimestamp(iso: string): string {
    return formatCommentTimestamp(iso);
  }

  protected canEdit(comment: Comment): boolean {
    return (
      this.config().allowEdit &&
      comment.authorId === this.currentUserId() &&
      this.editId() !== comment.id
    );
  }

  /** Admin moderation: any comment, gated on config (builders never see it). */
  protected canDelete(): boolean {
    return this.config().allowDelete;
  }

  protected submitPost(): void {
    const body = this.draft().trim();
    if (body.length === 0 || body.length > this.maxLength() || this.busy()) {
      return;
    }
    this.pendingOp.set({ op: 'post', baseline: this.comments() });
    this.post.emit({ body, visibility: this.postVisibility() });
  }

  protected startEdit(comment: Comment): void {
    if (!this.canEdit(comment) || this.busy()) {
      return;
    }
    this.deleteConfirmId.set(null);
    this.editId.set(comment.id);
    this.editDraft.set(comment.body);
  }

  protected cancelEdit(): void {
    this.editId.set(null);
    this.editDraft.set('');
  }

  protected submitEdit(comment: Comment): void {
    const body = this.editDraft().trim();
    if (
      body.length === 0 ||
      body.length > this.maxLength() ||
      body === comment.body ||
      this.busy()
    ) {
      return;
    }
    this.pendingOp.set({ op: 'edit', baseline: this.comments() });
    this.edit.emit({ id: comment.id, body });
  }

  protected askDelete(comment: Comment): void {
    if (this.busy()) {
      return;
    }
    this.editId.set(null);
    this.deleteConfirmId.set(comment.id);
  }

  protected cancelDelete(): void {
    this.deleteConfirmId.set(null);
  }

  protected confirmDelete(comment: Comment): void {
    if (this.busy()) {
      return;
    }
    this.pendingOp.set({ op: 'delete', baseline: this.comments() });
    this.delete.emit(comment.id);
  }
}
