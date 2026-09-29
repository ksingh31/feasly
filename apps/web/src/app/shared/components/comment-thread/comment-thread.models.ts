/**
 * Lead comment thread models — FRONTEND-OWNED INTERIM TYPES (BILL-06).
 *
 * These mirror the frozen BILL-05 API contract (2026-09-29). When
 * `@feasly/contracts` gains the Comment types, replace these interfaces
 * with imports (single source of truth) — field names are frozen, do not
 * rename without updating both sides.
 */

/** A single lead comment (frozen BILL-05 shape). */
export interface Comment {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly authorKind: 'builder' | 'admin';
  readonly authorId: string;
  readonly authorDisplayName: string;
  readonly visibility: 'org' | 'admin_only';
  readonly body: string;
  /** ISO-8601. */
  readonly createdAt: string;
  /** ISO-8601. */
  readonly updatedAt: string;
  readonly edited: boolean;
}

/** `GET /api/v1/builder/leads/{leadId}/comments` response (frozen contract). */
export interface CommentListResponse {
  readonly comments: readonly Comment[];
}

/**
 * Capability + display switches for the thread. The story freezes this
 * shape — both portals pass a config with these exact five flags.
 */
export interface CommentThreadConfig {
  readonly allowPost: boolean;
  readonly allowEdit: boolean;
  readonly allowDelete: boolean;
  readonly showVisibilityToggle: boolean;
  readonly showVisibilityBadges: boolean;
}

/**
 * Builder-portal config (story-frozen): builders post and edit their own
 * notes; they never see visibility controls, badges, or delete.
 */
export const BUILDER_COMMENT_THREAD_CONFIG: CommentThreadConfig = {
  allowPost: true,
  allowEdit: true,
  allowDelete: false,
  showVisibilityToggle: false,
  showVisibilityBadges: false,
};

/**
 * Emitted by (post). The composer carries a visibility choice when
 * `showVisibilityToggle` is on; otherwise the container applies its own
 * default. Builders always send 'org' (toggle hidden).
 */
export interface CommentPost {
  readonly body: string;
  readonly visibility?: 'org' | 'admin_only';
}

/** Emitted by (edit). */
export interface CommentEdit {
  readonly id: string;
  readonly body: string;
}

/**
 * Portal-overridable microcopy. The defaults are short neutral strings;
 * containers override individual keys with portal copy where voice matters.
 */
export interface CommentThreadLabels {
  readonly heading: string;
  readonly loadingThread: string;
  readonly emptyThread: string;
  readonly composerPlaceholder: string;
  readonly postLabel: string;
  readonly postingLabel: string;
  readonly editLabel: string;
  readonly saveLabel: string;
  readonly savingLabel: string;
  readonly cancelLabel: string;
  readonly deleteLabel: string;
  readonly deletingLabel: string;
  readonly confirmDeleteLabel: string;
  readonly editedMarker: string;
  readonly internalBadge: string;
  readonly dismissErrorLabel: string;
  readonly charactersMaxSuffix: string;
  readonly visibilityToggleLabel: string;
  readonly visibilityOrgLabel: string;
  readonly visibilityAdminOnlyLabel: string;
}

export const DEFAULT_COMMENT_THREAD_LABELS: CommentThreadLabels = {
  heading: 'Notes',
  loadingThread: 'Loading notes…',
  emptyThread: 'No notes yet.',
  composerPlaceholder: 'Write a note…',
  postLabel: 'Post',
  postingLabel: 'Posting…',
  editLabel: 'Edit',
  saveLabel: 'Save',
  savingLabel: 'Saving…',
  cancelLabel: 'Cancel',
  deleteLabel: 'Delete',
  deletingLabel: 'Deleting…',
  confirmDeleteLabel: 'Confirm delete',
  editedMarker: 'Edited',
  internalBadge: 'Internal',
  dismissErrorLabel: 'Dismiss',
  charactersMaxSuffix: 'characters max',
  visibilityToggleLabel: 'Who can see this note',
  visibilityOrgLabel: 'Visible to builder',
  visibilityAdminOnlyLabel: 'Internal only',
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

/**
 * Relative timestamp for a comment ("Just now", "5 min ago", "Yesterday",
 * else "Sep 28, 2026"). Rendered once — no live ticking (no orphaned
 * timers); a refresh re-renders.
 */
export function formatCommentTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) {
    return formatCommentDate(date);
  }
  if (diffMs < MINUTE_MS) {
    return 'Just now';
  }
  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return minutes === 1 ? '1 min ago' : `${minutes} min ago`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  if (days < WEEK_DAYS) {
    return days === 1 ? 'Yesterday' : `${days} days ago`;
  }
  return formatCommentDate(date);
}

function formatCommentDate(date: Date): string {
  return date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Oldest-first sort by `createdAt` (ISO-8601). Containers apply this so
 * the thread renders chronologically regardless of backend ordering.
 */
export function sortCommentsByOldest<T extends { readonly createdAt: string }>(
  comments: readonly T[],
): T[] {
  return [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
