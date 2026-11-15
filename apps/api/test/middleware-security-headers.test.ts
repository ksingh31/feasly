/**
 * Security headers for Function responses (BE8-002).
 *
 * - Every response carries nosniff, DENY framing, and a restrictive
 *   referrer policy.
 * - securityHeaders() returns a fresh copy each call (no shared-mutation
 *   hazard between concurrent invocations).
 * - HSTS is deliberately NOT set here — Azure terminates TLS at the edge.
 * - `Cache-Control: no-store` is the default (#795) so authenticated JSON
 *   (leads, users, reports, privacy export) never lands in a shared cache.
 */
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, securityHeaders } from '../src/middleware/security-headers';

describe('securityHeaders', () => {
  it('includes nosniff, DENY framing, strict referrer policy and no-store', () => {
    expect(securityHeaders()).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-store',
    });
  });

  it('returns a fresh copy on each call', () => {
    const a = securityHeaders();
    const b = securityHeaders();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    a['X-Content-Type-Options'] = 'mutated';
    expect(securityHeaders()['X-Content-Type-Options']).toBe('nosniff');
  });

  it('SECURITY_HEADERS constant matches the factory output', () => {
    expect({ ...SECURITY_HEADERS }).toEqual(securityHeaders());
  });

  it('does not set HSTS (Azure edge handles TLS)', () => {
    const headers = securityHeaders();
    expect(
      Object.keys(headers).some(
        (k) => k.toLowerCase() === 'strict-transport-security',
      ),
    ).toBe(false);
  });
});
