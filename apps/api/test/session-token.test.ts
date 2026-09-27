/**
 * Session-token extraction tests (ADM-10 bearer fix).
 *
 * The SPA is cross-origin to the Function App and modern browsers block
 * the third-party session cookie — so admin/builder requests authenticate
 * with `Authorization: Bearer <token>`, falling back to the httpOnly
 * session cookie for a same-origin future.
 */
import { describe, expect, it } from 'vitest';
import {
  extractSessionToken,
  parseBearerToken,
  parseCookieValue,
} from '../src/middleware/session-token';

describe('parseBearerToken', () => {
  it('extracts the token from a Bearer <redacted>', () => {
    expect(parseBearerToken({ authorization: 'Bearer abc123' })).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBearerToken({ authorization: 'bearer abc123' })).toBe('abc123');
  });

  it('trims surrounding whitespace', () => {
    expect(parseBearerToken({ authorization: '  Bearer   abc123  ' })).toBe('abc123');
  });

  it('returns null when the header is missing', () => {
    expect(parseBearerToken({})).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(parseBearerToken({ authorization: 'Basic xyz' })).toBeNull();
  });

  it('returns null for a bare "Bearer" with no token', () => {
    expect(parseBearerToken({ authorization: 'Bearer' })).toBeNull();
    expect(parseBearerToken({ authorization: 'Bearer   ' })).toBeNull();
  });

  it('reads the first value of a repeated header', () => {
    expect(parseBearerToken({ authorization: ['Bearer first', 'Bearer second'] })).toBe('first');
  });
});

describe('parseCookieValue', () => {
  it('extracts the named cookie', () => {
    expect(
      parseCookieValue(
        { cookie: 'other=1; feasly_admin_session=tok123; x=y' },
        'feasly_admin_session',
      ),
    ).toBe('tok123');
  });

  it('returns null when the cookie is absent', () => {
    expect(parseCookieValue({ cookie: 'other=1' }, 'feasly_admin_session')).toBeNull();
    expect(parseCookieValue({}, 'feasly_admin_session')).toBeNull();
  });

  it('URL-decodes the value', () => {
    expect(
      parseCookieValue({ cookie: 'feasly_admin_session=a%2Fb%2Bc' }, 'feasly_admin_session'),
    ).toBe('a/b+c');
  });

  it('returns null for an empty value', () => {
    expect(
      parseCookieValue({ cookie: 'feasly_admin_session=' }, 'feasly_admin_session'),
    ).toBeNull();
  });
});

describe('extractSessionToken', () => {
  it('prefers the Bearer <redacted> over the cookie', () => {
    expect(
      extractSessionToken(
        {
          authorization: 'Bearer bearer-token',
          cookie: 'feasly_admin_session=cookie-token',
        },
        'feasly_admin_session',
      ),
    ).toBe('bearer-token');
  });

  it('falls back to the cookie when no bearer header is present', () => {
    expect(
      extractSessionToken({ cookie: 'feasly_admin_session=cookie-token' }, 'feasly_admin_session'),
    ).toBe('cookie-token');
  });

  it('returns null when neither is present', () => {
    expect(extractSessionToken({}, 'feasly_admin_session')).toBeNull();
  });
});
