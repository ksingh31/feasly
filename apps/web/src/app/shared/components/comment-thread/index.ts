/** Lead comment thread (shared, BILL-06) — presentational, reused by both portals. */
export { CommentThreadComponent } from './comment-thread.component';
export type {
  Comment,
  CommentEditEvent,
  CommentListResponse,
  CommentPostEvent,
  CommentThreadConfig,
  CommentThreadLabels,
} from './comment-thread.models';
export {
  BUILDER_COMMENT_THREAD_CONFIG,
  DEFAULT_COMMENT_THREAD_LABELS,
  formatCommentTimestamp,
} from './comment-thread.models';
