/**
 * Real-user browser monitoring ingest (#830).
 *
 * Responsibilities (and nothing else):
 *  1. Parse the beacon body. `navigator.sendBeacon` posts a `text/plain`
 *     Blob (a CORS-safelisted type, so no preflight), so the body may
 *     arrive as a JSON string rather than an object.
 *  2. Validate it against the closed `WebTelemetryBatch` contract shape
 *     (unknown keys rejected, bounded sizes).
 *  3. Scrub defensively: error messages and script paths have email
 *     addresses and query strings removed even though the client already
 *     strips them — a stray `?token=` must never reach the logs.
 *  4. Emit one structured JSON trace per item through the injected sink
 *     (composition wires it to `console.info`, which the Functions host
 *     ships to App Insights `traces`). Queries: docs/ops/web-telemetry.md.
 *
 * Nothing is stored in Postgres. Error messages reference field paths only.
 */
import { z } from 'zod';
import type {
  WebErrorItem,
  WebTelemetryAccepted,
  WebTelemetryItem,
  WebVitalItem,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';

/** Most items one beacon may carry (4 vitals + a handful of errors per page). */
export const WEB_TELEMETRY_MAX_ITEMS = 25;
/** Longest error message kept (the client truncates first). */
export const WEB_TELEMETRY_MAX_MESSAGE = 300;
/** Longest route pattern / script path kept. */
export const WEB_TELEMETRY_MAX_PATH = 200;

const page = z.string().trim().min(1).max(WEB_TELEMETRY_MAX_PATH);

const VitalSchema = z
  .object({
    type: z.literal('vital'),
    name: z.enum(['LCP', 'INP', 'CLS', 'TTFB']),
    // An hour in ms bounds every timing metric; CLS is a small score.
    value: z.number().finite().min(0).max(3_600_000),
    rating: z.enum(['good', 'needs-improvement', 'poor']),
    page,
  })
  .strict();

const ErrorSchema = z
  .object({
    type: z.literal('error'),
    kind: z.enum(['error', 'unhandledrejection']),
    message: z.string().max(WEB_TELEMETRY_MAX_MESSAGE * 4),
    source: z.string().max(WEB_TELEMETRY_MAX_PATH * 4).optional(),
    line: z.number().int().min(0).optional(),
    column: z.number().int().min(0).optional(),
    page,
  })
  .strict();

export const WebTelemetryBatchSchema = z
  .object({
    items: z
      .array(z.discriminatedUnion('type', [VitalSchema, ErrorSchema]))
      .min(1)
      .max(WEB_TELEMETRY_MAX_ITEMS),
  })
  .strict();

/** One App Insights trace (JSON-serialised by the sink). */
export type WebTelemetryTrace =
  | ({ readonly event: 'web_vital' } & Omit<WebVitalItem, 'type'>)
  | ({ readonly event: 'web_error' } & Omit<WebErrorItem, 'type'>);

export interface WebTelemetryService {
  /** Validate one beacon batch and emit its traces. 400 VALIDATION_FAILED on a bad shape. */
  ingest(requestBody: unknown): Promise<WebTelemetryAccepted>;
}

export interface WebTelemetryServiceDeps {
  /** Trace sink — composition wires `console.info(JSON.stringify(trace))`. */
  readonly onTrace: (trace: WebTelemetryTrace) => void;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const QUERY_OR_HASH = /[?#][^\s)'"]*/g;

/** Removes email addresses and URL query strings / fragments. */
export function scrubTelemetryText(text: string, max: number): string {
  return text.replace(EMAIL, '[email]').replace(QUERY_OR_HASH, '').slice(0, max);
}

/** Script path only: drops scheme + host, query and fragment. */
function scrubSource(source: string): string {
  const withoutOrigin = source.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return scrubTelemetryText(withoutOrigin, WEB_TELEMETRY_MAX_PATH);
}

function parseBody(requestBody: unknown): unknown {
  if (typeof requestBody !== 'string') return requestBody;
  try {
    return JSON.parse(requestBody) as unknown;
  } catch {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid telemetry batch: body is not JSON.');
  }
}

function toTrace(item: WebTelemetryItem): WebTelemetryTrace {
  const pagePath = scrubTelemetryText(item.page, WEB_TELEMETRY_MAX_PATH);
  if (item.type === 'vital') {
    return { event: 'web_vital', name: item.name, value: item.value, rating: item.rating, page: pagePath };
  }
  return {
    event: 'web_error',
    kind: item.kind,
    message: scrubTelemetryText(item.message, WEB_TELEMETRY_MAX_MESSAGE),
    ...(item.source !== undefined ? { source: scrubSource(item.source) } : {}),
    ...(item.line !== undefined ? { line: item.line } : {}),
    ...(item.column !== undefined ? { column: item.column } : {}),
    page: pagePath,
  };
}

export function createWebTelemetryService(deps: WebTelemetryServiceDeps): WebTelemetryService {
  return {
    async ingest(requestBody: unknown): Promise<WebTelemetryAccepted> {
      const parsed = WebTelemetryBatchSchema.safeParse(parseBody(requestBody));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? first.path.join('.') : 'body';
        // Field path only — never echo the submitted value.
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, `Invalid telemetry batch at '${where}'.`);
      }
      for (const item of parsed.data.items) {
        deps.onTrace(toTrace(item));
      }
      return { accepted: parsed.data.items.length };
    },
  };
}
