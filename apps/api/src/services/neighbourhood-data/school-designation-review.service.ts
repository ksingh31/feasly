/**
 * School designation review (#775).
 *
 * When the monthly refresh finds designations that differ from the stored
 * ones, this files ONE GitHub issue for a person to check against the
 * boards' notices. Deduplicated by title: while a review issue is open, a
 * later change is added to it as a comment instead of a new issue.
 *
 * No GitHub token configured → logged only (detect, do not file). A GitHub
 * error throws, so the refresh fails, keeps the stored designations and
 * retries the next day — a change is never stored unreviewed.
 *
 * The issue carries public school data only (community, board, grade band,
 * school names) — no personal data, never the token.
 */
import type { GitHubIssuesClient } from '../github-issues.client';
import type { DesignationChange } from './school-designations';

export const SCHOOL_DESIGNATIONS_REVIEW_ISSUE_TITLE = 'School designations changed — review needed';
export const SCHOOL_DESIGNATIONS_REVIEW_ISSUE_LABELS: readonly string[] = ['ops', 'area:api'];

/** Max change rows listed in one issue/comment (the rest are counted). */
const MAX_ROWS = 200;

export type DesignationReviewOutcome = 'created' | 'commented' | 'no-token' | 'no-changes';

export interface SchoolDesignationReviewServiceDeps {
  /** Absent when no GitHub token is configured. */
  readonly issues?: GitHubIssuesClient;
  readonly logger?: { readonly info: (m: string) => void; readonly warn: (m: string) => void };
}

export interface SchoolDesignationReviewService {
  /** Files (or comments on) the one review issue. Throws on a GitHub error. */
  report(changes: readonly DesignationChange[], refreshedAt: Date): Promise<DesignationReviewOutcome>;
}

function cell(value: string | null): string {
  return value === null ? '—' : value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

/** Markdown body listing the changes (stable order from the diff). */
export function designationReviewBody(changes: readonly DesignationChange[], refreshedAt: Date): string {
  const rows = changes
    .slice(0, MAX_ROWS)
    .map(
      (c) =>
        `| ${cell(c.communityName)} (${cell(c.communityCode)}) | ${c.board.toUpperCase()} | ${cell(c.gradeBand)} | ${c.kind} | ${cell(c.before)} | ${cell(c.after)} |`,
    );
  const more = changes.length > MAX_ROWS ? `\n\n…and ${changes.length - MAX_ROWS} more.` : '';
  return [
    `The monthly school-designation refresh on ${refreshedAt.toISOString().slice(0, 10)} found ` +
      `${changes.length} designation${changes.length === 1 ? '' : 's'} that differ from the stored ones.`,
    '',
    'Check each against the board notice (CBE / CCSD), then fix `school-designations.data.ts` if needed. ' +
      'The refresh stores the new designations once this issue is filed; they show as "typically designated" with the board lookup links.',
    '',
    '| Community | Board | Grades | Change | Before | After |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n') + more;
}

export function createSchoolDesignationReviewService(
  deps: SchoolDesignationReviewServiceDeps,
): SchoolDesignationReviewService {
  const logger = deps.logger ?? { info: (m: string) => console.info(m), warn: (m: string) => console.warn(m) };
  return {
    async report(changes, refreshedAt): Promise<DesignationReviewOutcome> {
      if (changes.length === 0) return 'no-changes';
      if (!deps.issues) {
        logger.warn(
          `school-designations: ${changes.length} designation(s) changed, but no GitHub token is configured — no review issue filed`,
        );
        return 'no-token';
      }
      const body = designationReviewBody(changes, refreshedAt);
      const open = await deps.issues.findOpenByTitle(SCHOOL_DESIGNATIONS_REVIEW_ISSUE_TITLE);
      if (open) {
        await deps.issues.comment(open.number, `More designation changes since this issue was opened:\n\n${body}`);
        logger.info(`school-designations: added ${changes.length} change(s) to review issue #${open.number}`);
        return 'commented';
      }
      const created = await deps.issues.create({
        title: SCHOOL_DESIGNATIONS_REVIEW_ISSUE_TITLE,
        body,
        labels: SCHOOL_DESIGNATIONS_REVIEW_ISSUE_LABELS,
      });
      logger.info(`school-designations: opened review issue #${created.number}`);
      return 'created';
    },
  };
}
