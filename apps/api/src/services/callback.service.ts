/**
 * Callback requests (phase-2 wiring).
 *
 * A "call me back" ask attached to a report: validates the contract shape,
 * resolves the report token to its lead (unknown/expired tokens → 404),
 * and persists the request row. The token itself is never stored — only
 * the leadId.
 *
 * PLACEHOLDER: no outbound email/SMS is sent yet. The team works callback
 * requests from the future inbox flow; the confirmation email send is
 * tracked as follow-up work for when the outbound sender (ACS) is live.
 * #840: when that send lands, a sandbox lead (`lead.sandbox`) must route
 * it through `createSandboxSuppressingEmailService`, as share.service does.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  CallbackRequest,
  CallbackResponse,
  CallbackWindow,
  LeadCallbackSummary,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import { requireOwnerLink, resolveReportToken } from './report-context';
import {
  DISPUTE_SLA_TIMEZONE,
  calendarDateKey,
  isBusinessDateWithin,
} from '../lib/business-days';
import type {
  CallbackRequestRecord,
  CallbackRequestStore,
  NewCallbackRequest,
} from './callback-request.store';

/** #836: callback days run on the same Calgary calendar as billing. */
export const CALLBACK_TIMEZONE = DISPUTE_SLA_TIMEZONE;
/** #836: notes cap (characters). */
export const CALLBACK_NOTES_MAX_LENGTH = 500;
/** Default preferred-day window when the deps omit it (config default). */
const DEFAULT_DATE_WINDOW_DAYS = 14;

/** Request validation — mirrors the contracts `CallbackRequest` shape. */
export const CallbackRequestSchema = z
  .object({
    reportToken: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(7).max(32),
    window: z.enum(['morning', 'afternoon', 'evening']),
    preferredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Preferred day must be a YYYY-MM-DD date.')
      .optional(),
    notes: z.string().trim().max(CALLBACK_NOTES_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * #836: the request schema plus the calendar rule — the preferred day must
 * be a business day from tomorrow through `windowDays` days ahead on the
 * America/Edmonton calendar at `now`.
 */
export function callbackRequestSchemaAt(now: Date, windowDays: number) {
  const todayKey = calendarDateKey(now, CALLBACK_TIMEZONE);
  return CallbackRequestSchema.refine(
    (body) =>
      body.preferredDate === undefined ||
      isBusinessDateWithin(body.preferredDate, todayKey, windowDays),
    {
      message: `Preferred day must be a weekday within the next ${windowDays} days.`,
      path: ['preferredDate'],
    },
  );
}

/** #836: stored row → the portal/admin `LeadCallbackSummary` contract. */
export function toLeadCallbackSummary(
  record: CallbackRequestRecord,
): LeadCallbackSummary {
  return {
    id: record.id,
    window: record.window as CallbackWindow,
    preferredDate: record.preferredDate,
    notes: record.notes,
    phone: record.phone,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface CallbackService {
  /**
   * Record a callback request on an untrusted request body. Unknown or
   * expired report tokens → HttpError(404); partner-share tokens →
   * HttpError(403) — the callback is the owner's "call me back" flow.
   */
  requestCallback(requestBody: unknown): Promise<CallbackResponse>;
}

export interface CallbackServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly callbacks: CallbackRequestStore;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
  /** #836: config `lead.callbackDateWindowDays` (default 14). */
  readonly dateWindowDays?: number;
}

export function createCallbackService(deps: CallbackServiceDeps): CallbackService {
  const clock = deps.clock ?? (() => new Date());
  const windowDays = deps.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  return {
    async requestCallback(requestBody: unknown): Promise<CallbackResponse> {
      const parsed = callbackRequestSchemaAt(clock(), windowDays).safeParse(
        requestBody,
      );
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          parsed.error.issues[0]?.message ?? 'Invalid callback request.',
          false,
        );
      }
      const request: CallbackRequest = parsed.data;
      const { lead, linkPurpose } = await resolveReportToken(
        { magicLinks: deps.magicLinks, leads: deps.leads, clock },
        request.reportToken,
      );
      // The callback is booked against the owner's lead — a partner link
      // must not file one on the owner's behalf.
      requireOwnerLink(linkPurpose);
      const stored: NewCallbackRequest = {
        id: randomUUID(),
        leadId: lead.id,
        name: request.name.trim(),
        phone: request.phone.trim(),
        window: request.window,
        preferredDate: request.preferredDate ?? null,
        notes: request.notes?.trim() ? request.notes.trim() : null,
      };
      await deps.callbacks.insert(stored);
      return {
        ok: true,
        window: request.window,
        preferredDate: request.preferredDate ?? null,
      };
    },
  };
}
