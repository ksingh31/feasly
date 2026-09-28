/**
 * EntraTokenValidator (auth/02) — Microsoft Entra External ID token handling.
 *
 * Two responsibilities, no database:
 * 1. `exchangeCode` — POST the PKCE authorization code to the tenant's
 *    OAuth2 token endpoint and return the `id_token`. The user flow travels
 *    as the `p` query parameter on the token endpoint URL — the same
 *    placement the authorize request uses (Entra External ID rejects the
 *    exchange when it can't select the flow); the access token is
 *    discarded: we never call Graph on the user's behalf.
 * 2. `validateIdToken` — verify the id_token's RS256 signature against the
 *    tenant JWKS (cached, short TTL), then check `iss`, `aud` (= our client
 *    id) and `exp`. Returns the verified identity claims (`oid`, email,
 *    name) the callback service uses to resolve our user row.
 *
 * Signature verification uses node:crypto directly (no JWT dependency):
 * the algorithm is pinned to exactly `RS256` and the signing key must
 * match the token's `kid` in the tenant JWKS — a token signed with any
 * other algorithm, or with an unknown key, is rejected.
 *
 * Security: the authorization code, code verifier, and tokens are NEVER
 * logged. Entra's token-endpoint errors are mapped to buyer-grade messages;
 * the technical reason travels on `error.cause` (an Error carrying a
 * machine code) so it lands in server logs via the request pipeline but
 * never in the client response.
 */
import { createPublicKey, verify } from 'node:crypto';
import { ErrorCodes, HttpError } from '../middleware/errors';

export interface EntraTokenValidatorConfig {
  /** False while AUTH-00 hasn't provisioned the tenant — fail closed. */
  readonly configured: boolean;
  /** Tenant OAuth2 token endpoint (derived in config.ts). */
  readonly tokenEndpoint: string;
  /** Tenant JWKS discovery URI (derived in config.ts). */
  readonly jwksUri: string;
  /** Expected `iss` claim (derived in config.ts). */
  readonly issuer: string;
  /** Application (client) id — the expected `aud` claim. */
  readonly clientId: string;
  /**
   * Client secret for the `feasly-web` app registration. Sent as
   * `client_secret` in the token request body: the redirect URI is
   * registered on the "Web" platform, so the token endpoint treats the
   * backend as a confidential client and rejects the exchange with HTTP
   * 401 `invalid_client` when the secret is absent. Never logged.
   */
  readonly clientSecret: string;
  /**
   * Sign-in user flow name (e.g. `feasly-signup-signin`) — sent as the `p`
   * query parameter on the token endpoint URL, matching the frontend's
   * authorize request. From config, never hardcoded.
   */
  readonly userFlow: string;
  /** How long a fetched JWKS may be reused (ms). */
  readonly jwksCacheTtlMs: number;
  /** HTTP timeout (ms) for the token/JWKS calls. */
  readonly httpTimeoutMs: number;
}

export interface EntraTokenValidatorDeps extends EntraTokenValidatorConfig {
  readonly fetchImpl?: typeof fetch;
  /** ms epoch — injectable for tests. */
  readonly clock?: () => number;
}

export interface EntraCodeExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/** Verified identity claims extracted from the id_token. */
export interface EntraVerifiedIdentity {
  /** Entra object id (`oid`, falling back to `sub`). */
  readonly entraObjectId: string;
  /** Verified sign-in email (lowercased). */
  readonly email: string;
  /** Display name (`name`, falling back to the email local part). */
  readonly name: string;
}

export interface EntraTokenValidator {
  readonly configured: boolean;
  /**
   * Exchange the PKCE authorization code for tokens. Returns the id_token;
   * the access token is discarded. Replayed/expired codes surface as a 401
   * with buyer-grade copy ("Sign-in didn't complete — try again.").
   */
  exchangeCode(
    input: EntraCodeExchangeInput,
  ): Promise<{ readonly idToken: string }>;
  /** Verify signature + iss/aud/exp and extract the identity claims. */
  validateIdToken(idToken: string): Promise<EntraVerifiedIdentity>;
}

interface JwksKey {
  readonly kid: string;
  readonly kty: 'RSA';
  readonly use: string | undefined;
  readonly n: string;
  readonly e: string;
}

interface JwksCache {
  keys: readonly JwksKey[];
  fetchedAtMs: number;
}

/** Clock-skew leeway (seconds) applied to exp/nbf/iat checks. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Build an HttpError with a machine-readable `cause` for server logs.
 * The pipeline logs `error.cause` but the client only ever sees `message`.
 */
function fail(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  causeCode: string,
): HttpError {
  const error = new HttpError(status, code, message, retryable);
  error.cause = new Error(causeCode);
  return error;
}

/** Uniform 401 — never reveal which validation check failed (no oracle). */
function deny(causeCode: string): HttpError {
  return fail(
    401,
    ErrorCodes.UNAUTHENTICATED,
    'Sign-in didn\u2019t complete — try again.',
    false,
    causeCode,
  );
}

function base64UrlDecode(input: string): Buffer {
  // Throws on malformed input — callers map it to a 401.
  return Buffer.from(input, 'base64url');
}

function parseJsonObject(raw: string, causeCode: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw deny(causeCode);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw deny(causeCode);
  }
  return parsed as Record<string, unknown>;
}

export function createEntraTokenValidator(
  deps: EntraTokenValidatorDeps,
): EntraTokenValidator {
  const {
    configured,
    tokenEndpoint,
    jwksUri,
    issuer,
    clientId,
    clientSecret,
    userFlow,
    jwksCacheTtlMs,
    httpTimeoutMs,
    fetchImpl = fetch,
    clock = () => Date.now(),
  } = deps;

  let jwksCache: JwksCache | null = null;

  function ensureConfigured(): void {
    if (!configured) {
      throw fail(
        503,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'Sign-in isn\u2019t available right now — the sign-in service is still being set up. Try again later.',
        false,
        'entra_unconfigured',
      );
    }
  }

  async function fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJsonSafe(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /** Map the token endpoint's error to a buyer-grade HttpError. */
  function tokenEndpointError(status: number, body: unknown): HttpError {
    const payload =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const code = payload.error;
    const errorCode = typeof code === 'string' ? code : '';
    // Upstream diagnostics: Entra returns AADSTS numeric codes plus a
    // Microsoft-generated description. Those never contain our
    // authorization code, verifier, or tokens, so they are safe to carry on
    // error.cause — which lands in server logs via the request pipeline but
    // never in the client response. Without them a rejected exchange is
    // undebuggable (we only saw the bare `invalid_request` category).
    const errorCodes = Array.isArray(payload.error_codes)
      ? payload.error_codes.filter(
          (c): c is number => typeof c === 'number' && Number.isFinite(c),
        )
      : [];
    const upstreamSuffix =
      errorCodes.length > 0 ? `:aadsts_${errorCodes.join('_')}` : '';
    // invalid_grant = expired, already-redeemed, or mismatched code/verifier/
    // redirect_uri. invalid_request = malformed request. Neither is retryable
    // as-is; the user must start sign-in again.
    if (errorCode === 'invalid_grant') {
      return fail(
        401,
        ErrorCodes.UNAUTHENTICATED,
        'Sign-in didn\u2019t complete — try again.',
        false,
        `token_endpoint_invalid_grant${upstreamSuffix}`,
      );
    }
    if (errorCode === 'invalid_request') {
      return fail(
        400,
        ErrorCodes.VALIDATION_FAILED,
        'Sign-in didn\u2019t complete — try again.',
        false,
        `token_endpoint_invalid_request${upstreamSuffix}`,
      );
    }
    return fail(
      502,
      ErrorCodes.DEPENDENCY_UNAVAILABLE,
      'We couldn\u2019t reach the sign-in service. Try again in a moment.',
      true,
      `token_endpoint_http_${status}`,
    );
  }

  async function exchangeCode(
    input: EntraCodeExchangeInput,
  ): Promise<{ readonly idToken: string }> {
    ensureConfigured();
    // Entra External ID selects the sign-in user flow from the `p` query
    // parameter — the same placement the authorize request uses. A `p` form
    // field is non-standard here and the exchange was rejected with
    // invalid_request, so the flow rides on the URL, not the body.
    const tokenUrl = `${tokenEndpoint}?p=${encodeURIComponent(userFlow)}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          // Confidential-client authentication: the redirect URI is on the
          // "Web" platform, so the token endpoint requires the secret.
          client_secret: clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }).toString(),
      });
    } catch (error) {
      // Network failure or timeout — the code/verifier never enter the message.
      throw fail(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'We couldn\u2019t reach the sign-in service. Try again in a moment.',
        true,
        error instanceof Error && error.name === 'AbortError'
          ? 'token_endpoint_timeout'
          : 'token_endpoint_network',
      );
    }
    if (!response.ok) {
      throw tokenEndpointError(response.status, await readJsonSafe(response));
    }
    const json = (await readJsonSafe(response)) as {
      id_token?: unknown;
    } | null;
    if (!json || typeof json.id_token !== 'string' || json.id_token === '') {
      throw fail(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'The sign-in service returned an unexpected response. Try again in a moment.',
        true,
        'token_endpoint_missing_id_token',
      );
    }
    return { idToken: json.id_token };
  }

  async function fetchJwks(): Promise<readonly JwksKey[]> {
    const nowMs = clock();
    if (jwksCache && nowMs - jwksCache.fetchedAtMs < jwksCacheTtlMs) {
      return jwksCache.keys;
    }
    let json: unknown;
    try {
      const response = await fetchWithTimeout(jwksUri, {});
      if (!response.ok) {
        throw fail(
          502,
          ErrorCodes.DEPENDENCY_UNAVAILABLE,
          'We couldn\u2019t reach the sign-in service. Try again in a moment.',
          true,
          `jwks_http_${response.status}`,
        );
      }
      json = await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw fail(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'We couldn\u2019t reach the sign-in service. Try again in a moment.',
        true,
        error instanceof Error && error.name === 'AbortError'
          ? 'jwks_timeout'
          : 'jwks_network',
      );
    }
    const keys =
      typeof json === 'object' && json !== null
        ? (json as { keys?: unknown }).keys
        : undefined;
    if (!Array.isArray(keys)) {
      throw fail(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'The sign-in service returned an unexpected response. Try again in a moment.',
        true,
        'jwks_malformed',
      );
    }
    const parsed: JwksKey[] = [];
    for (const key of keys) {
      if (
        typeof key === 'object' &&
        key !== null &&
        typeof (key as { kid?: unknown }).kid === 'string' &&
        (key as { kty?: unknown }).kty === 'RSA' &&
        typeof (key as { n?: unknown }).n === 'string' &&
        typeof (key as { e?: unknown }).e === 'string'
      ) {
        parsed.push({
          kid: (key as { kid: string }).kid,
          kty: 'RSA',
          use:
            typeof (key as { use?: unknown }).use === 'string'
              ? (key as { use: string }).use
              : undefined,
          n: (key as { n: string }).n,
          e: (key as { e: string }).e,
        });
      }
    }
    jwksCache = { keys: parsed, fetchedAtMs: nowMs };
    return parsed;
  }

  async function validateIdToken(
    idToken: string,
  ): Promise<EntraVerifiedIdentity> {
    ensureConfigured();
    const parts = idToken.split('.');
    if (parts.length !== 3) throw deny('jwt_malformed');
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = parseJsonObject(
        base64UrlDecode(parts[0]!).toString('utf8'),
        'jwt_header_malformed',
      );
      payload = parseJsonObject(
        base64UrlDecode(parts[1]!).toString('utf8'),
        'jwt_payload_malformed',
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw deny('jwt_decode_failed');
    }
    // Algorithm pinning: only RS256 is ever accepted (alg-confusion defense).
    if (header['alg'] !== 'RS256') throw deny('jwt_unexpected_alg');
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid === '') throw deny('jwt_missing_kid');

    const keys = await fetchJwks();
    const jwk = keys.find(
      (k) => k.kid === kid && (k.use === undefined || k.use === 'sig'),
    );
    if (!jwk) throw deny('jwt_unknown_kid');

    let publicKey;
    try {
      publicKey = createPublicKey({
        key: { kty: 'RSA', n: jwk.n, e: jwk.e },
        format: 'jwk',
      });
    } catch {
      throw deny('jwt_bad_jwk');
    }
    let signature: Buffer;
    try {
      signature = base64UrlDecode(parts[2]!);
    } catch {
      throw deny('jwt_signature_malformed');
    }
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    let ok = false;
    try {
      ok = verify('RSA-SHA256', signingInput, publicKey, signature);
    } catch {
      ok = false;
    }
    if (!ok) throw deny('jwt_bad_signature');

    // Claims.
    if (payload['iss'] !== issuer) throw deny('jwt_bad_iss');
    const aud = payload['aud'];
    const audOk =
      aud === clientId || (Array.isArray(aud) && aud.includes(clientId));
    if (!audOk) throw deny('jwt_bad_aud');

    const nowSec = Math.floor(clock() / 1000);
    const exp = payload['exp'];
    if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS <= nowSec) {
      throw deny('jwt_expired');
    }
    const nbf = payload['nbf'];
    if (typeof nbf === 'number' && nbf - CLOCK_SKEW_SECONDS > nowSec) {
      throw deny('jwt_not_yet_valid');
    }
    const iat = payload['iat'];
    if (typeof iat === 'number' && iat - CLOCK_SKEW_SECONDS > nowSec) {
      throw deny('jwt_issued_in_future');
    }

    const entraObjectId =
      typeof payload['oid'] === 'string' && payload['oid'] !== ''
        ? payload['oid']
        : typeof payload['sub'] === 'string' && payload['sub'] !== ''
          ? payload['sub']
          : null;
    if (!entraObjectId) throw deny('jwt_missing_oid');

    // CIAM user flows emit `email`; fall back to `preferred_username` and
    // the legacy `emails` array. The email is the verified sign-in identity.
    const emails = payload['emails'];
    const rawEmail =
      typeof payload['email'] === 'string' && payload['email'].trim() !== ''
        ? payload['email']
        : typeof payload['preferred_username'] === 'string' &&
            payload['preferred_username'].trim() !== ''
          ? payload['preferred_username']
          : Array.isArray(emails) &&
              typeof emails[0] === 'string' &&
              (emails[0] as string).trim() !== ''
            ? (emails[0] as string)
            : null;
    if (!rawEmail) throw deny('jwt_missing_email');
    const email = rawEmail.trim().toLowerCase();

    const name =
      typeof payload['name'] === 'string' && payload['name'].trim() !== ''
        ? payload['name'].trim()
        : (email.split('@')[0] ?? email);

    return { entraObjectId, email, name };
  }

  return { configured, exchangeCode, validateIdToken };
}
