/**
 * Unsubscribe token tests (email/03).
 *
 * The token is a stateless HMAC: `leadId.iat.signature`. These tests pin
 * the security properties the story demands — forged tokens are rejected
 * (AC1), expired tokens read as expired (AC2, with the "request a new link"
 * path), and verification needs nothing but the secret.
 */
import { describe, expect, it } from 'vitest';
import {
  issueUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../src/services/unsubscribe-token';

const SECRET = 'test-secret-please-ignore';
const OTHER_SECRET = 'a-different-secret';
const LEAD_ID = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-09-25T00:00:00.000Z');
const TTL = 2_592_000; // 30 days

function issue(overrides?: {
  leadId?: string;
  secret?: string;
  now?: Date;
}): string {
  return issueUnsubscribeToken({
    leadId: overrides?.leadId ?? LEAD_ID,
    secret: overrides?.secret ?? SECRET,
    now: overrides?.now ?? NOW,
  });
}

function verify(token: string, overrides?: { secret?: string; now?: Date; ttl?: number }) {
  return verifyUnsubscribeToken({
    token,
    secret: overrides?.secret ?? SECRET,
    ttlSeconds: overrides?.ttl ?? TTL,
    now: overrides?.now ?? NOW,
  });
}

describe('issueUnsubscribeToken / verifyUnsubscribeToken', () => {
  it('round-trips: a freshly issued token verifies with its leadId', () => {
    const verdict = verify(issue());
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.claims.leadId).toBe(LEAD_ID);
      expect(verdict.claims.issuedAt).toEqual(NOW);
    }
  });

  it('rejects a token signed with a different secret (forged token → invalid)', () => {
    const verdict = verify(issue({ secret: OTHER_SECRET }));
    expect(verdict).toEqual({ valid: false, reason: 'invalid' });
  });

  it('rejects a tampered leadId', () => {
    const token = issue();
    const parts = token.split('.');
    const tampered = `99999999-9999-4999-8999-999999999999.${parts[1]}.${parts[2]}`;
    expect(verify(tampered)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('rejects a tampered timestamp', () => {
    const token = issue();
    const parts = token.split('.');
    const tampered = `${parts[0]}.1.${parts[2]}`;
    expect(verify(tampered)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('rejects a tampered signature', () => {
    const token = issue();
    const tampered = token.slice(0, -2) + 'xx';
    expect(verify(tampered)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('rejects malformed tokens (wrong part count, non-UUID, bad timestamp)', () => {
    expect(verify('just-a-string')).toEqual({ valid: false, reason: 'invalid' });
    expect(verify('a.b.c.d')).toEqual({ valid: false, reason: 'invalid' });
    expect(verify(`not-a-uuid.123.${'x'.repeat(43)}`)).toEqual({
      valid: false,
      reason: 'invalid',
    });
    expect(verify(`${LEAD_ID}.not-a-number.${'x'.repeat(43)}`)).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('reads an expired token as expired (AC2 — the UI shows the refresh path)', () => {
    const issued = new Date(NOW.getTime() - (TTL + 60) * 1000);
    const verdict = verify(issue({ now: issued }));
    expect(verdict).toEqual({ valid: false, reason: 'expired' });
  });

  it('accepts a token just inside the TTL boundary', () => {
    const issued = new Date(NOW.getTime() - (TTL - 60) * 1000);
    expect(verify(issue({ now: issued })).valid).toBe(true);
  });

  it('rejects tokens issued in the future beyond clock-skew tolerance', () => {
    const future = new Date(NOW.getTime() + 3600 * 1000);
    expect(verify(issue({ now: future }))).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('is deterministic given (leadId, secret, now)', () => {
    expect(issue()).toBe(issue());
  });

  it('binds the token to the lead: different leads get different tokens', () => {
    const other = issue({ leadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(other).not.toBe(issue());
    const verdict = verify(other);
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.claims.leadId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    }
  });
});
