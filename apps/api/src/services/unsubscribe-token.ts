/**
 * One-click unsubscribe tokens (email/03).
 *
 * Stateless signed tokens: `leadId.iat.signature` where signature is the
 * base64url HMAC-SHA256 of `leadId.iat` under UNSUBSCRIBE_TOKEN_SECRET.
 * No database row per token — verification needs only the secret, so there
 * is nothing to store or revoke. Tokens are valid for
 * UNSUBSCRIBE_TOKEN_TTL_SECONDS (30 days); expired or forged tokens are
 * rejected with no state change.
 *
 * Identity note: the story says "HMAC over user_id" — this codebase has no
 * separate users table; the lead row IS the identity, so the token binds
 * the lead's UUID. Possession of the link (delivered to the lead's own
 * inbox) is the credential, the same model as magic links.
 *
 * Never logged: tokens are PII-grade bearer credentials.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UnsubscribeTokenClaims {
  readonly leadId: string;
  readonly issuedAt: Date;
}

export type UnsubscribeTokenVerdict =
  | { readonly valid: true; readonly claims: UnsubscribeTokenClaims }
  | { readonly valid: false; readonly reason: 'invalid' | 'expired' };

/** Lead IDs are UUIDs (hex + dashes) — never contain '.', so split is safe. */
const LEAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 5 minutes of clock skew tolerated for not-yet-valid tokens. */
const FUTURE_SKEW_TOLERANCE_SECONDS = 300;

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error('not base64url');
  }
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function signatureFor(leadId: string, issuedAtSeconds: number, secret: string): Buffer {
  return createHmac('sha256', secret)
    .update(`${leadId}.${issuedAtSeconds}`, 'utf8')
    .digest();
}

/**
 * Mint a one-click unsubscribe token for a lead. Pure and deterministic
 * given (leadId, secret, now) — tests pin `now` for expiry coverage.
 */
export function issueUnsubscribeToken(args: {
  readonly leadId: string;
  readonly secret: string;
  readonly now?: Date;
}): string {
  const issuedAtSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const signature = signatureFor(args.leadId, issuedAtSeconds, args.secret);
  return `${args.leadId}.${issuedAtSeconds}.${base64UrlEncode(signature)}`;
}

/**
 * Verify a presented token. Forged, malformed, and future tokens all read
 * as `invalid` — the endpoint is not an oracle for which lead IDs exist.
 * Expired tokens read as `expired` so the UI can show the "request a new
 * link" path (the story's no-dead-end rule).
 */
export function verifyUnsubscribeToken(args: {
  readonly token: string;
  readonly secret: string;
  readonly ttlSeconds: number;
  readonly now?: Date;
}): UnsubscribeTokenVerdict {
  const parts = args.token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'invalid' };
  }
  const [leadId, issuedAtRaw, signatureRaw] = parts;
  if (!LEAD_ID_PATTERN.test(leadId)) {
    return { valid: false, reason: 'invalid' };
  }
  const issuedAtSeconds = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAtSeconds) || issuedAtSeconds <= 0) {
    return { valid: false, reason: 'invalid' };
  }
  let presented: Buffer;
  try {
    presented = base64UrlDecode(signatureRaw);
  } catch {
    return { valid: false, reason: 'invalid' };
  }
  const expected = signatureFor(leadId, issuedAtSeconds, args.secret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { valid: false, reason: 'invalid' };
  }
  const nowSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
  if (issuedAtSeconds - nowSeconds > FUTURE_SKEW_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'invalid' };
  }
  if (nowSeconds - issuedAtSeconds > args.ttlSeconds) {
    return { valid: false, reason: 'expired' };
  }
  return {
    valid: true,
    claims: { leadId, issuedAt: new Date(issuedAtSeconds * 1000) },
  };
}
