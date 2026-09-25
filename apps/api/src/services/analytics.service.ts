/**
 * Analytics event ingest service (story consumer/01).
 *
 * Responsibilities (and nothing else):
 *  1. Validate the request shape with Zod against the `AnalyticsEvent`
 *     contract — `consent_ts` is required, not optional.
 *  2. Enforce the event allowlist: only the closed `AnalyticsEventName`
 *     union is accepted. Arbitrary event collection is a 400, not a
 *     schema drift risk.
 *  3. Enforce the consent gate: missing `consent_ts` → 400
 *     CONSENT_REQUIRED; a future-dated `consent_ts` (beyond a small clock
 *     skew allowance) → 400 CONSENT_REQUIRED. Consent is proven per event.
 *  4. Append the event to the store. Append-only — no read, update, or
 *     delete path exists.
 *
 * PII discipline: the payload shape is closed — email, name, and address
 * cannot be submitted (Zod strips nothing; it rejects unknown keys), and
 * error messages reference field *paths*, never field *values*. Nothing in
 * this service logs the body.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AnalyticsEvent, AnalyticsEventName } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AnalyticsStore } from './analytics.store';

/**
 * The allowlist mirrors the `AnalyticsEventName` contract union. A second
 * source of truth is deliberate: the service must keep working even if the
 * contract package lags, and the test suite pins them equal.
 */
export const ANALYTICS_EVENT_ALLOWLIST: readonly AnalyticsEventName[] = [
  'step_view',
  'gate_view',
  'gate_convert',
  'report_open',
  'tier_toggle',
  'callback_request',
  'partner_share',
  'pdf_download',
  'embed_loaded',
];

/**
 * Clock-skew allowance for client timestamps. A `consent_ts` more than this
 * far in the future is treated as forged/mistaken, not as skew.
 */
export const CONSENT_SKEW_ALLOWANCE_MS = 60_000;

const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO timestamp' });

export const AnalyticsEventSchema = z
  .object({
    event: z.enum(ANALYTICS_EVENT_ALLOWLIST as [AnalyticsEventName, ...AnalyticsEventName[]]),
    route: z.string().trim().min(1).max(200),
    ts: isoDateTime,
    consent_ts: isoDateTime,
    // admin/07: optional tenant attribution for embed clients. Additive —
    // old clients omit it and are stored as Feasly-direct (NULL).
    tenant_key: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type AnalyticsEventRequest = z.infer<typeof AnalyticsEventSchema>;

export interface AnalyticsService {
  /**
   * Validate and append one analytics event. Rejects with HttpError(400,
   * CONSENT_REQUIRED) when consent_ts is missing or future-dated, and
   * HttpError(400, VALIDATION_FAILED) for any other shape violation.
   * Resolves to the stored event (contract shape).
   */
  ingestEvent(requestBody: unknown): Promise<AnalyticsEvent>;
}

export interface AnalyticsServiceDeps {
  readonly store: AnalyticsStore;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const clock = deps.clock ?? (() => new Date());

  return {
    async ingestEvent(requestBody: unknown): Promise<AnalyticsEvent> {
      const parsed = AnalyticsEventSchema.safeParse(requestBody);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first ? first.path.join('.') : 'body';
        // A missing consent_ts must surface as CONSENT_REQUIRED, not a
        // generic validation failure — the client distinguishes them.
        const isConsentMissing =
          first?.code === 'invalid_type' && first.path[0] === 'consent_ts';
        if (isConsentMissing) {
          throw new HttpError(
            400,
            ErrorCodes.CONSENT_REQUIRED,
            "The 'consent_ts' field is required: analytics events must carry the consent-banner acknowledgement timestamp.",
          );
        }
        // Field path only — never echo the submitted value.
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Invalid analytics event at '${where}'.`,
        );
      }
      const { event, route, ts, consent_ts, tenant_key } = parsed.data;
      const consentDate = new Date(consent_ts);
      if (consentDate.getTime() > clock().getTime() + CONSENT_SKEW_ALLOWANCE_MS) {
        throw new HttpError(
          400,
          ErrorCodes.CONSENT_REQUIRED,
          "The 'consent_ts' field is dated in the future: events must carry the actual consent-banner acknowledgement timestamp.",
        );
      }
      const record = await deps.store.insert({
        id: randomUUID(),
        event,
        route,
        ts: new Date(ts),
        consentTs: consentDate,
        tenantKey: tenant_key ?? null,
      });
      return {
        event: record.event as AnalyticsEventName,
        route: record.route,
        ts: record.ts.toISOString(),
        consent_ts: record.consentTs.toISOString(),
      };
    },
  };
}
