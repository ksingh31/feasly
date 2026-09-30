/**
 * Lead comment thread models — shared presentational types (BILL-06).
 *
 * `Comment` and `CommentListResponse` are the frozen BILL-05 API contract:
 * `@feasly/contracts` is the single source of truth (re-exported below).
 * Everything else in this file is UI-owned (config, labels, formatting).
 */
import type { CommentVisibility } from '@feasly/contracts';
export type { Comment, CommentListResponse } from '@feasly/contracts';

/**
 * Capability + display switches for the thread. The story froze this
 * shape at five flags; the notes-section redesign adds `showAuthorBadges`
 * (builder portal only — the admin console already distinguishes authors
 * by other means and stays unchanged).
 */
export interface CommentThreadConfig {
  readonly allowPost: boolean;
  readonly allowEdit: boolean;
  readonly allowDelete: boolean;
  readonly showVisibilityToggle: boolean;
  readonly showVisibilityBadges: boolean;
  /**
   * Render the `adminAuthorBadgeLabel` badge on admin-authored comments
   * (shared admin notes in the builder portal). False on the admin side.
   */
  readonly showAuthorBadges: boolean;
  /**
   * Render the thread's own <h3> heading. The notes-section redesign
   * renders its own header row (title + live count badge), so the
   * builder container sets this false to avoid a duplicated "Notes".
   * Defaults to true when omitted — the admin console is unchanged.
   */
  readonly showHeading?: boolean;
}

/**
 * Builder-portal config (story-frozen): builders post and edit their own
 * notes; they never see visibility controls, badges, or delete. Shared
 * admin notes carry the "Feasly team" badge so builders know the source.
 */
export const BUILDER_COMMENT_THREAD_CONFIG: CommentThreadConfig = {
  allowPost: true,
  allowEdit: true,
  allowDelete: false,
  showVisibilityToggle: false,
  showVisibilityBadges: false,
  showAuthorBadges: true,
  // The lead card's notes section renders its own header row with the
  // live count badge — the thread's duplicate <h3> stays hidden.
  showHeading: false,
};

/**
 * Emitted by (post). The composer carries a visibility choice when
 * `showVisibilityToggle` is on; otherwise the container applies its own
 * default. Builders always send 'org' (toggle hidden).
 */
export interface CommentPost {
  readonly body: string;
  readonly visibility?: CommentVisibility;
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
  /** Badge on admin-authored comments (builder portal only). */
  readonly adminAuthorBadgeLabel: string;
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
  adminAuthorBadgeLabel: 'Feasly team',
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
