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
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallbackRequest, CallbackResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import { resolveReportToken } from './report-context';
import type {
  CallbackRequestStore,
  NewCallbackRequest,
} from './callback-request.store';

/** Request validation — mirrors the contracts `CallbackRequest` shape. */
export const CallbackRequestSchema = z
  .object({
    reportToken: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(7).max(32),
    window: z.enum(['morning', 'afternoon', 'evening']),
  })
  .strict();

export interface CallbackService {
  /**
   * Record a callback request on an untrusted request body. Unknown or
   * expired report tokens → HttpError(404).
   */
  requestCallback(requestBody: unknown): Promise<CallbackResponse>;
}

export interface CallbackServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly callbacks: CallbackRequestStore;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

export function createCallbackService(deps: CallbackServiceDeps): CallbackService {
  const clock = deps.clock ?? (() => new Date());
  return {
    async requestCallback(requestBody: unknown): Promise<CallbackResponse> {
      const parsed = CallbackRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          parsed.error.issues[0]?.message ?? 'Invalid callback request.',
          false,
        );
      }
      const request: CallbackRequest = parsed.data;
      const { lead } = await resolveReportToken(
        { magicLinks: deps.magicLinks, leads: deps.leads, clock },
        request.reportToken,
      );
      const stored: NewCallbackRequest = {
        id: randomUUID(),
        leadId: lead.id,
        name: request.name.trim(),
        phone: request.phone.trim(),
        window: request.window,
      };
      await deps.callbacks.insert(stored);
      return { ok: true, window: request.window };
    },
  };
}
