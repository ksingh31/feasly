import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * PLACEHOLDER — BILL-06 owns the real `comment-thread` component.
 *
 * This file exists so BILL-07 (admin console) can build and verify against
 * the component surface spec'd in `plan/stories/billing/06-builder-lead-comments-portal.md`
 * while BILL-06 is still on a parallel lane. It implements the spec'd
 * inputs/outputs/config faithfully (plus two documented extensions), but
 * the styling and polish are intentionally minimal.
 *
 * DELETE THIS FILE when BILL-06 merges — their implementation replaces it.
 * The admin container (`features/admin/admin-lead-comments.component.ts`)
 * is written purely against the surface below, so it must not change.
 */

/** Visibility of a single comment (mirrors the BILL-05 frozen contract). */
export type ThreadCommentVisibility = 'org' | 'admin_only';

/**
 * Comment shape the thread renders. Structurally identical to the BILL-05
 * frozen `Comment` — the admin container passes its `LeadComment[]`
 * straight through (structural typing, no mapping).
 */
export interface ThreadComment {
  readonly id: string;
  readonly authorKind: 'builder' | 'admin';
  readonly authorId: string;
  readonly authorDisplayName: string;
  readonly visibility: ThreadCommentVisibility;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly edited: boolean;
}

/**
 * Config driving the thread's portal-specific behavior. The builder portal
 * (BILL-06) uses `{ allowPost: true, allowEdit: true, allowDelete: false,
 * showVisibilityToggle: false, showVisibilityBadges: false }`; the admin
 * console (BILL-07) sets everything true.
 */
export interface CommentThreadConfig {
  readonly allowPost: boolean;
  readonly allowEdit: boolean;
  readonly allowDelete: boolean;
  readonly showVisibilityToggle: boolean;
  readonly showVisibilityBadges: boolean;
}

/**
 * Payload of the `post` output.
 *
 * EXTENSION beyond the BILL-06 spec (`post(body)`): when
 * `showVisibilityToggle` is true the composer carries a visibility choice,
 * so the event also reports it. Builders never see the toggle and their
 * container ignores the field — backward compatible.
 */
export interface CommentPost {
  readonly body: string;
  readonly visibility?: ThreadCommentVisibility;
}

/** Payload of the `edit` output. */
export interface CommentEdit {
  readonly id: string;
  readonly body: string;
}

/** Client-side body cap (mirrors the API's 2000-char service-layer cap). */
export const COMMENT_BODY_MAX = 2000;

/** "2h ago" style relative timestamp for the thread. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

@Component({
  selector: 'app-comment-thread',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './comment-thread.component.html',
  styleUrls: ['./comment-thread.component.scss'],
})
export class CommentThreadComponent {
  /** Thread contents; rendered oldest-first. */
  readonly comments = input<readonly ThreadComment[]>([]);
  /** Id of the viewing user — drives the "own comment" edit affordance. */
  readonly currentUserId = input<string>('');
  readonly config = input.required<CommentThreadConfig>();
  /** True while the container's post call is in flight (disables composer). */
  readonly busy = input<boolean>(false);

  readonly post = output<CommentPost>();
  readonly edit = output<CommentEdit>();
  readonly delete = output<string>();

  protected readonly draft = signal('');
  /** Composer visibility choice — always defaults to Internal only (safe default). */
  protected readonly draftVisibility = signal<ThreadCommentVisibility>('admin_only');
  protected readonly editingId = signal<string | null>(null);
  protected readonly editDraft = signal('');
  protected readonly confirmingDeleteId = signal<string | null>(null);

  protected readonly sorted = computed(() =>
    [...this.comments()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
  protected readonly canPost = computed(() => this.draft().trim().length > 0 && !this.busy());

  /**
   * Edit-affordance rule.
   *
   * The builder story specs "own comments only". `allowDelete` is the
   * moderator capability — only the admin config sets it (per both
   * stories) — so a moderator who can delete anything can edit anything.
   * This keeps the config surface exactly as spec'd (no new inputs).
   */
  protected canEdit(comment: ThreadComment): boolean {
    const cfg = this.config();
    return cfg.allowEdit && (comment.authorId === this.currentUserId() || cfg.allowDelete);
  }

  protected canDelete(): boolean {
    return this.config().allowDelete;
  }

  protected showInternalBadge(comment: ThreadComment): boolean {
    return this.isInternal(comment) && this.config().showVisibilityBadges;
  }

  protected isInternal(comment: ThreadComment): boolean {
    return comment.visibility === 'admin_only';
  }

  protected timeAgo(iso: string): string {
    return timeAgo(iso);
  }

  protected initial(name: string): string {
    return (name.trim().charAt(0) || '?').toUpperCase();
  }

  protected submitPost(): void {
    const body = this.draft().trim();
    if (!body || this.busy()) return;
    const payload: CommentPost = this.config().showVisibilityToggle
      ? { body, visibility: this.draftVisibility() }
      : { body };
    this.post.emit(payload);
    this.draft.set('');
    // Keep the safe default for the next note.
    this.draftVisibility.set('admin_only');
  }

  protected startEdit(comment: ThreadComment): void {
    this.editingId.set(comment.id);
    this.editDraft.set(comment.body);
    this.confirmingDeleteId.set(null);
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
    this.editDraft.set('');
  }

  protected submitEdit(id: string): void {
    const body = this.editDraft().trim();
    if (!body) return;
    this.edit.emit({ id, body });
    this.cancelEdit();
  }

  protected askDelete(id: string): void {
    this.confirmingDeleteId.set(id);
    this.cancelEdit();
  }

  protected cancelDelete(): void {
    this.confirmingDeleteId.set(null);
  }

  protected confirmDelete(id: string): void {
    this.delete.emit(id);
    this.confirmingDeleteId.set(null);
  }
}
