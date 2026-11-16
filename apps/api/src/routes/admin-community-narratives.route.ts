/**
 * Thin admin community-narratives routes (#759). Routes are adapters:
 * admin guard → validate → one service call → audit → serialize.
 *
 * - GET  /api/v1/admin/community-narratives — each community's latest
 *   period, status, and generated date.
 * - POST /api/v1/admin/community-narratives/regenerate — "Regenerate now"
 *   for one community (`{ community_slug }`) or all (`{}`), for when the
 *   City publishes new data mid-month. Every attempt is recorded in
 *   `admin_audit_log` with the acting admin.
 *
 * Hard rules (test/boundaries.test.ts): never imports src/db/, never reads
 * process.env, depends on service interfaces only.
 */
import { z } from 'zod';
import type {
  AdminCommunityNarrativeRegenerateResponse,
  AdminCommunityNarrativesResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { AdminAuditStore } from '../services/admin-audit.store';
import type { CommunityNarrativeService } from '../services/community-narrative.service';

type Headers = Record<string, string | string[] | undefined>;

export interface AdminCommunityNarrativesRouteDeps {
  readonly narratives: Pick<CommunityNarrativeService, 'listStatus' | 'regenerate'>;
  readonly audit: Pick<AdminAuditStore, 'append'>;
  readonly adminGuard: AdminGuard;
}

export interface AdminCommunityNarrativesRoute {
  /** GET /api/v1/admin/community-narratives */
  list(headers: Headers): Promise<AdminCommunityNarrativesResponse>;
  /** POST /api/v1/admin/community-narratives/regenerate */
  regenerate(headers: Headers, body: unknown): Promise<AdminCommunityNarrativeRegenerateResponse>;
}

/** Machine-readable action recorded in admin_audit_log. */
export const COMMUNITY_NARRATIVE_REGENERATE_AUDIT_ACTION = 'community_narrative_regenerate';

const regenerateSchema = z
  .object({
    community_slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'community_slug must be a kebab-case slug')
      .max(100)
      .optional(),
  })
  .strict();

export function createAdminCommunityNarrativesRoute(
  deps: AdminCommunityNarrativesRouteDeps,
): AdminCommunityNarrativesRoute {
  const { narratives, audit, adminGuard } = deps;

  async function auditAttempt(actorEmail: string, detail: string): Promise<void> {
    try {
      await audit.append({
        action: COMMUNITY_NARRATIVE_REGENERATE_AUDIT_ACTION,
        actorEmail,
        detail,
      });
    } catch (auditError) {
      // Audit is best-effort: never mask the regenerate outcome.
      console.error('community-narratives: audit append failed', auditError);
    }
  }

  return {
    async list(headers): Promise<AdminCommunityNarrativesResponse> {
      await adminGuard.requireAdmin(headers);
      const entries = await narratives.listStatus();
      return {
        communities: entries.map((e) => ({
          community_slug: e.communitySlug,
          community_name: e.communityName,
          period: e.period,
          status: e.status,
          generated_at: e.generatedAt ? e.generatedAt.toISOString() : null,
          attempts: e.attempts,
          last_error: e.lastError,
        })),
      };
    },

    async regenerate(headers, body): Promise<AdminCommunityNarrativeRegenerateResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = regenerateSchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Send {} to regenerate every community, or { "community_slug": "<slug>" } for one.',
          false,
        );
      }
      const slug = parsed.data.community_slug;
      const scope = slug === undefined ? 'all' : 'one';
      const actorEmail = (await adminGuard.getAdminEmail(headers)) ?? 'unknown';
      const target = `community=${slug ?? '*'}`;
      try {
        const result = await narratives.regenerate({ communitySlug: slug });
        await auditAttempt(
          actorEmail,
          `ok ${target} period=${result.period} attempted=${result.attempted} ` +
            `succeeded=${result.succeeded} failed=${result.failed} deferred=${result.deferred}`,
        );
        return {
          scope,
          period: result.period ?? '',
          attempted: result.attempted,
          succeeded: result.succeeded,
          failed: result.failed,
          deferred: result.deferred,
        };
      } catch (error) {
        await auditAttempt(
          actorEmail,
          `error ${target} ${error instanceof Error ? error.constructor.name : 'UnknownError'}`,
        );
        throw error;
      }
    },
  };
}
