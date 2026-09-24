/**
 * Correlation IDs (BE0-003).
 *
 * Every request carries one: the client-supplied `x-correlation-id` when
 * present, otherwise a generated UUID. It travels on the pipeline context
 * into logs and onto every error response, so a user report can be traced
 * to the exact server-side log lines.
 */
import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';

export type HeaderValue = string | string[] | undefined;

export function ensureCorrelationId(
  headers: Record<string, HeaderValue>,
): string {
  const incoming = headers[CORRELATION_HEADER];
  const first = Array.isArray(incoming) ? incoming[0] : incoming;
  const trimmed = first?.trim();
  return trimmed ? trimmed : randomUUID();
}
