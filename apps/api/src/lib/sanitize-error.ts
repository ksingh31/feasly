/**
 * Error-message sanitizer (admin/05).
 *
 * Pure helper: turns a thrown error into a short, safe, human-readable
 * string for the Sheets sync ops panel and the `sheets_sync_runs` table.
 * Raw error text can carry credentials (service-account keys, API keys,
 * tokens) and PII (lead emails/names from the Google API client), so the
 * sanitizer redacts both before anything is persisted or displayed.
 *
 * Redactions:
 * - email addresses → `[redacted-email]`
 * - `key/secret/token/password`-style assignments → `[redacted]`
 * - Bearer tokens → `Bearer [redacted]`
 * - PEM blocks / long base64-ish secrets → `[redacted]`
 *
 * No I/O, no clock, no env. Tested in test/sanitize-error.test.ts.
 */

/** Max characters kept — failure messages are summaries, not logs. */
export const SANITIZED_ERROR_MAX_LENGTH = 500;

/**
 * Extract a safe message from an unknown thrown value. Never returns
 * credentials or PII; never returns an empty string (falls back to the
 * error's constructor name).
 */
export function sanitizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? 'Unknown error';
            } catch {
              return 'Unknown error';
            }
          })();

  let out = raw;

  // Email addresses (lead PII in Google client errors).
  out = out.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    '[redacted-email]',
  );

  // PEM blocks (service-account private keys).
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[redacted-key]',
  );

  // key/secret/token/password-style assignments: api_key=..., "secret": "...".
  out = out.replace(
    /((?:api[_-]?key|private[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret)\s*[:=]\s*)(["']?)[^"'\s,}]+(["']?)/gi,
    '$1[redacted]$3',
  );

  // Bearer tokens.
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*=?/gi, 'Bearer [redacted]');

  // Dotted opaque tokens (JWTs: base64url.base64url.signature). The
  // segment-wise regex below would only catch long individual segments, so
  // dotted tokens get their own branch first.
  out = out.replace(
    /\b(?:[A-Za-z0-9\-_]{15,}\.){2}[A-Za-z0-9\-_]{15,}={0,2}\b/g,
    '[redacted-token]',
  );

  // Long opaque tokens (base64 blobs ≥ 40 chars) — keep short codes
  // (HTTP statuses, error names) intact.
  out = out.replace(/\b[A-Za-z0-9\-_]{40,}={0,2}\b/g, (m) =>
    /^\d+$/.test(m) ? m : '[redacted-token]',
  );

  // Collapse whitespace (multiline API errors become one line).
  out = out.replace(/\s+/g, ' ').trim();

  if (!out) {
    out =
      error instanceof Error && error.constructor.name
        ? error.constructor.name
        : 'Unknown error';
  }

  if (out.length > SANITIZED_ERROR_MAX_LENGTH) {
    out = `${out.slice(0, SANITIZED_ERROR_MAX_LENGTH - 1)}…`;
  }

  return out;
}
