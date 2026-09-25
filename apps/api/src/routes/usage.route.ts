/**
 * Thin usage route (api-mcp/07). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * `GET /api/v1/admin/usage?key_id=&from=&to=` — per-day usage aggregates
 * by endpoint + estimates_created (billing-ready).
 *
 * Auth: admins (via `AdminGuard`) see all keys; API key owners (via
 * Bearer token) see only their own key. Key owners passing another
 * key's `key_id` get a 403.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { ApiKeyService } from '../services/api-key.service';
import type {
  UsageAggregate,
  UsageService,
} from '../services/usage.service';

export interface UsageRouteDeps {
  readonly usage: UsageService;
  readonly apiKeys: ApiKeyService;
  readonly adminGuard: AdminGuard;
}

export interface UsageRoute {
  /**
   * GET /api/v1/admin/usage?key_id=&from=&to=
   * `from`/`to` are ISO-8601 dates (inclusive). Response is per-day
   * aggregates: [{ date, endpoint, count, estimates_created }].
   */
  getUsage(
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string | undefined>,
  ): Promise<readonly UsageAggregateResponse[]>;
}

export interface UsageAggregateResponse {
  readonly date: string;
  readonly endpoint: string;
  readonly count: number;
  readonly estimates_created: number;
}

const querySchema = z.object({
  key_id: z.string().trim().min(1).max(120).optional(),
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
});

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Invalid ${name} date: expected ISO-8601.`,
      false,
    );
  }
  return d;
}

function bearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer (.+)$/.exec(value.trim());
  return match ? match[1]!.trim() : null;
}

export function createUsageRoute(deps: UsageRouteDeps): UsageRoute {
  const { usage, apiKeys, adminGuard } = deps;

  return {
    async getUsage(headers, query): Promise<readonly UsageAggregateResponse[]> {
      const parsed = querySchema.safeParse(query);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid usage query parameters.',
          false,
        );
      }
      const from = parseDate(parsed.data.from, 'from');
      const to = parseDate(parsed.data.to, 'to');
      if (from && to && from > to) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid date range: from must not be after to.',
          false,
        );
      }

      // Admin path: X-Admin-Key valid → sees all keys (or the filtered one).
      try {
        adminGuard.requireAdmin(headers);
        const aggregates = await usage.getUsage(
          { apiKeyId: parsed.data.key_id, from, to },
          { kind: 'admin' },
        );
        return aggregates.map(toResponse);
      } catch (e) {
        // Only fall through on auth failure; internal errors propagate.
        if (
          !(e instanceof HttpError) ||
          e.status !== 401 ||
          e.code !== ErrorCodes.UNAUTHENTICATED
        ) {
          throw e;
        }
        // Not an admin — fall through to key-owner auth.
      }

      // Owner path: Bearer API key → sees only its own key.
      const token = bearerToken(headers);
      if (!token) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Admin or API key authentication required.',
          false,
        );
      }
      // Authenticate without leaking which check failed (no oracle).
      let keyId: string;
      try {
        const record = await apiKeys.authenticate(token);
        keyId = record.id;
      } catch {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Admin or API key authentication required.',
          false,
        );
      }

      const aggregates = await usage.getUsage(
        { apiKeyId: parsed.data.key_id, from, to },
        { kind: 'owner', apiKeyId: keyId },
      );
      return aggregates.map(toResponse);
    },
  };
}

function toResponse(a: UsageAggregate): UsageAggregateResponse {
  return {
    date: a.date,
    endpoint: a.endpoint,
    count: a.count,
    estimates_created: a.estimatesCreated,
  };
}
