/**
 * PKCE helper specs (auth/02 pivot).
 *
 * - The S256 challenge pins the RFC 7636 Appendix B test vector, so a
 *   wrong digest/encoding can't silently break the Entra exchange.
 * - Verifier/state formats pin the RFC 7636 §4.1 character/length window.
 */
import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  createCodeChallenge,
  createCodeVerifier,
  createOAuthState,
} from './admin-entra-pkce';

const VERIFIER_CHARSET = /^[A-Za-z0-9\-_~.]+$/;

describe('admin-entra-pkce', () => {
  it('base64UrlEncode produces unpadded base64url', () => {
    // 0xfb 0xef 0xbe -> "+/++" in base64 -> "-_--" base64url, no padding.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xef, 0xbe]))).toBe('-___');
    expect(base64UrlEncode(new Uint8Array([0x00]))).toBe('AA');
  });

  it('createCodeChallenge matches the RFC 7636 Appendix B vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await expect(createCodeChallenge(verifier)).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('createCodeVerifier returns an 86-char RFC 7636 verifier', () => {
    const verifier = createCodeVerifier();
    expect(verifier).toHaveLength(86);
    expect(verifier).toMatch(VERIFIER_CHARSET);
  });

  it('createCodeVerifier is random per call', () => {
    expect(createCodeVerifier()).not.toBe(createCodeVerifier());
  });

  it('createOAuthState returns a 43-char base64url state', () => {
    const state = createOAuthState();
    expect(state).toHaveLength(43);
    expect(state).toMatch(VERIFIER_CHARSET);
  });

  it('createOAuthState is random per call', () => {
    expect(createOAuthState()).not.toBe(createOAuthState());
  });
});
