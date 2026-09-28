/**
 * Entra token validator tests (auth/02).
 *
 * A real RSA key pair is generated in-process; the JWKS and id_tokens are
 * built from it, so signature verification is exercised for real. The
 * token endpoint and JWKS URI are mocked fetch handlers — no network.
 *
 * Never asserts on (or logs) the code, verifier, or tokens beyond the
 * mocked values needed to drive the exchange.
 */
import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createEntraTokenValidator,
  type EntraTokenValidatorDeps,
} from '../src/services/entra-token-validator';
import { ErrorCodes } from '../src/middleware/errors';

const ISSUER = 'https://tenant-123.ciamlogin.com/tenant-123/v2.0';
const CLIENT_ID = 'client-abc';
const USER_FLOW = 'feasly-signup-signin';
const TOKEN_ENDPOINT =
  'https://feaslytest.ciamlogin.com/tenant-123/oauth2/v2.0/token';
/** The exchange must carry the user flow as `p` on the token URL (query). */
const TOKEN_URL_WITH_FLOW = `${TOKEN_ENDPOINT}?p=${encodeURIComponent(USER_FLOW)}`;
const JWKS_URI = 'https://feaslytest.ciamlogin.com/tenant-123/discovery/v2.0/keys';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

interface KeyMaterial {
  privateKey: ReturnType<typeof createPrivateKey>;
  jwks: { keys: unknown[] };
}

function makeKeys(kid: string): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return {
    privateKey: createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })),
    jwks: {
      keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }],
    },
  };
}

function makeIdToken(
  privateKey: ReturnType<typeof createPrivateKey>,
  opts: {
    kid?: string;
    alg?: string;
    payload?: Record<string, unknown>;
    tamperPayload?: boolean;
  } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'key-1', typ: 'JWT' }),
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: nowSec + 3600,
      iat: nowSec,
      oid: 'entra-oid-1',
      email: 'Admin@Example.com',
      name: 'Ada Admin',
      ...(opts.payload ?? {}),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey);
  const sigB64 = b64url(signature);
  if (opts.tamperPayload) {
    // Flip a payload char without re-signing → bad signature.
    const tampered = payload.slice(0, -2) + (payload.endsWith('AA') ? 'AB' : 'AA');
    return `${header}.${tampered}.${sigB64}`;
  }
  return `${header}.${payload}.${sigB64}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Mock fetch routing token/JWKS calls; records calls for cache assertions. */
function mockFetch(handlers: {
  token?: (body: URLSearchParams) => Response;
  jwks?: () => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u === TOKEN_URL_WITH_FLOW) {
      const body = new URLSearchParams(String((init as { body?: string }).body ?? ''));
      return (handlers.token ?? (() => jsonResponse({ id_token: 'unused' })))(body);
    }
    if (u === JWKS_URI) {
      return handlers.jwks ? await handlers.jwks() : jsonResponse({ keys: [] });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  return { fetchImpl, calls };
}

function validatorDeps(
  overrides: Partial<EntraTokenValidatorDeps> & {
    fetchImpl: (url: unknown, init?: RequestInit) => Promise<Response>;
  },
): EntraTokenValidatorDeps {
  return {
    configured: true,
    tokenEndpoint: TOKEN_ENDPOINT,
    jwksUri: JWKS_URI,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    userFlow: USER_FLOW,
    jwksCacheTtlMs: 600_000,
    httpTimeoutMs: 5_000,
    ...overrides,
  } as EntraTokenValidatorDeps;
}

const EXCHANGE_INPUT = {
  code: 'auth-code',
  codeVerifier: 'verifier',
  redirectUri: 'https://app.example/admin/auth/callback',
};

describe('entra token validator — code exchange', () => {
  it('returns the id_token on success (access token discarded)', async () => {
    const { privateKey, jwks } = makeKeys('key-1');
    const idToken = makeIdToken(privateKey);
    const { fetchImpl } = mockFetch({
      token: () => jsonResponse({ id_token: idToken, access_token: 'at', token_type: 'Bearer' }),
      jwks: () => jsonResponse(jwks),
    });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    const result = await v.exchangeCode(EXCHANGE_INPUT);
    expect(result).toEqual({ idToken });
  });

  it('sends the PKCE form fields to the token endpoint (no p in the body)', async () => {
    let seen: URLSearchParams | null = null;
    const { fetchImpl } = mockFetch({
      token: (body) => {
        seen = body;
        return jsonResponse({ id_token: 't' });
      },
    });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    await v.exchangeCode(EXCHANGE_INPUT);
    expect(seen!.get('grant_type')).toBe('authorization_code');
    expect(seen!.get('client_id')).toBe(CLIENT_ID);
    expect(seen!.get('code')).toBe('auth-code');
    expect(seen!.get('code_verifier')).toBe('verifier');
    expect(seen!.get('redirect_uri')).toBe('https://app.example/admin/auth/callback');
    // The user flow rides on the token URL's `p` query param (mockFetch only
    // routes the URL with it) — it must NOT also be a form field.
    expect(seen!.has('p')).toBe(false);
  });

  it('carries the user flow as the p query param on the token URL', async () => {
    const { fetchImpl, calls } = mockFetch({
      token: () => jsonResponse({ id_token: 't' }),
    });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    await v.exchangeCode(EXCHANGE_INPUT);
    expect(calls).toContain(TOKEN_URL_WITH_FLOW);
  });

  it('invalid_request carries the upstream AADSTS codes on the server cause', async () => {
    const { fetchImpl } = mockFetch({
      token: () =>
        new Response(
          JSON.stringify({
            error: 'invalid_request',
            error_description: 'AADSTS90023: malformed',
            error_codes: [90023],
          }),
          { status: 400 },
        ),
    });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    const error = await v.exchangeCode(EXCHANGE_INPUT).catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(error.message).toBe('Sign-in didn\u2019t complete — try again.');
    // Buyer-grade message stays clean; the AADSTS code lands in server logs.
    expect(error.message).not.toContain('90023');
    expect(String((error.cause as Error | undefined)?.message)).toContain('aadsts_90023');
  });

  it('invalid_grant (replayed/expired code) → 401 buyer-grade', async () => {
    const { fetchImpl } = mockFetch({
      token: () =>
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' }),
          { status: 400 },
        ),
    });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    const error = await v.exchangeCode(EXCHANGE_INPUT).catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCodes.UNAUTHENTICATED);
    expect(error.message).toBe('Sign-in didn\u2019t complete — try again.');
    // The technical reason stays out of the client message.
    expect(error.message).not.toContain('invalid_grant');
  });

  it('network failure → 502 retryable, no secret in the message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    const error = await v.exchangeCode(EXCHANGE_INPUT).catch((e) => e);
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('auth-code');
    expect(error.message).not.toContain('verifier');
  });

  it('missing id_token in a 200 response → 502', async () => {
    const { fetchImpl } = mockFetch({
      token: () => jsonResponse({ access_token: 'at' }),
    });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    const error = await v.exchangeCode(EXCHANGE_INPUT).catch((e) => e);
    expect(error.status).toBe(502);
  });

  it('unconfigured → 503 without touching the network', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const v = createEntraTokenValidator(
      validatorDeps({ fetchImpl, configured: false }),
    );
    const error = await v.exchangeCode(EXCHANGE_INPUT).catch((e) => e);
    expect(error.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('entra token validator — id_token verification', () => {
  function setup(payload?: Record<string, unknown>) {
    const { privateKey, jwks } = makeKeys('key-1');
    const idToken = makeIdToken(privateKey, { payload });
    const { fetchImpl, calls } = mockFetch({ jwks: () => jsonResponse(jwks) });
    const v = createEntraTokenValidator(validatorDeps({ fetchImpl }));
    return { v, idToken, privateKey, calls };
  }
  it('valid token → verified identity (email lowercased)', async () => {
    const { v, idToken } = setup();
    const identity = await v.validateIdToken(idToken);
    expect(identity).toEqual({
      entraObjectId: 'entra-oid-1',
      email: 'admin@example.com',
      name: 'Ada Admin',
    });
  });

  it('tampered payload → 401', async () => {
    const { v, privateKey } = setup();
    const bad = makeIdToken(privateKey, { tamperPayload: true });
    const error = await v.validateIdToken(bad).catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.message).toBe('Sign-in didn\u2019t complete — try again.');
  });

  it('alg=none → 401 (algorithm pinning)', async () => {
    const { v, privateKey } = setup();
    const noneToken = makeIdToken(privateKey, { alg: 'none' });
    // Strip the signature to mimic an alg=none attack token.
    const parts = noneToken.split('.');
    const error = await v.validateIdToken(`${parts[0]}.${parts[1]}.`).catch((e) => e);
    expect(error.status).toBe(401);
  });

  it('unknown kid → 401', async () => {
    const { v, privateKey } = setup();
    const bad = makeIdToken(privateKey, { kid: 'attacker-key' });
    const error = await v.validateIdToken(bad).catch((e) => e);
    expect(error.status).toBe(401);
  });

  it('wrong iss / aud / expired → 401', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const payload of [
      { iss: 'https://evil.example/tenant-123/v2.0' },
      { aud: 'other-client' },
      { exp: nowSec - 3600 },
    ]) {
      const { v, idToken } = setup(payload);
      const error = await v.validateIdToken(idToken).catch((e) => e);
      expect(error.status).toBe(401);
    }
  });

  it('array aud containing our client id → accepted', async () => {
    const { v, idToken } = setup({ aud: ['other', CLIENT_ID] });
    const identity = await v.validateIdToken(idToken);
    expect(identity.email).toBe('admin@example.com');
  });

  it('JWKS is cached: second validation issues no fetch', async () => {
    const { v, idToken, calls } = setup();
    await v.validateIdToken(idToken);
    await v.validateIdToken(idToken);
    expect(calls.filter((u) => u === JWKS_URI)).toHaveLength(1);
  });

  it('malformed token → 401', async () => {
    const { v } = setup();
    const error = await v.validateIdToken('not-a-jwt').catch((e) => e);
    expect(error.status).toBe(401);
  });

  it('missing email claim → 401', async () => {
    const { v, privateKey } = setup();
    const idToken = makeIdToken(privateKey);
    // Remove email-ish claims entirely.
    const parts = idToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    delete payload.email;
    delete payload.preferred_username;
    const reheader = parts[0]!;
    const resign = `${reheader}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const sig = b64url(sign('RSA-SHA256', Buffer.from(resign, 'utf8'), privateKey));
    const error = await v.validateIdToken(`${resign}.${sig}`).catch((e) => e);
    expect(error.status).toBe(401);
  });

  it('preferred_username falls back when email is absent', async () => {
    const { v, privateKey } = setup();
    const raw = makeIdToken(privateKey);
    const parts = raw.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    delete payload.email;
    payload.preferred_username = 'Fallback@Example.com';
    const resign = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const sig = b64url(sign('RSA-SHA256', Buffer.from(resign, 'utf8'), privateKey));
    const identity = await v.validateIdToken(`${resign}.${sig}`);
    expect(identity.email).toBe('fallback@example.com');
  });

  it('unconfigured → 503', async () => {
    const unconfigured = createEntraTokenValidator(
      validatorDeps({
        fetchImpl: vi.fn(async () => jsonResponse({})),
        configured: false,
      }),
    );
    const error = await unconfigured.validateIdToken('x.y.z').catch((e) => e);
    expect(error.status).toBe(503);
  });
});
