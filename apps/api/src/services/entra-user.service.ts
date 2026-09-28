/**
 * EntraUserService (auth/01) — Microsoft Entra External ID user lifecycle.
 *
 * Karan's decision (2026-09-27): Feasly stores NO passwords. Entra owns the
 * credential; we keep only the Entra object id on our user row. This
 * service is the only module that talks to Microsoft Graph, using the
 * OAuth2 client-credentials flow (no user context — it runs from admin
 * actions like "invite user").
 *
 * Operations: create an external user with an email sign-in identity,
 * enable/disable the account, and delete it. The Graph client secret lives
 * in Key Vault (plain env locally); it is sent only to the Microsoft token
 * endpoint and is never logged, never emailed, and never appears in an
 * error message.
 *
 * The tenant is being created in parallel: until ENTRA_TENANT_ID,
 * ENTRA_GRAPH_CLIENT_ID, ENTRA_GRAPH_CLIENT_SECRET, and
 * ENTRA_ISSUER_DOMAIN are all set, every method fails closed with a clear
 * 503. Unit tests inject a mocked fetch — there is no live tenant to
 * integration-test against yet.
 */
import { randomBytes } from 'node:crypto';
import { ErrorCodes, HttpError } from '../middleware/errors';

export interface EntraUserConfig {
  readonly tenantId: string;
  readonly graphClientId: string;
  readonly graphClientSecret: string;
  /**
   * Issuer domain for the email sign-in identity, e.g.
   * `feaslyexternal.onmicrosoft.com` (from the tenant's domain list).
   */
  readonly issuerDomain: string;
  /**
   * Microsoft endpoints — stable global URLs injected from config (the
   * boundaries test forbids URL literals in services/).
   */
  readonly loginBaseUrl: string;
  readonly graphBaseUrl: string;
  readonly configured: boolean;
}

export interface EntraUserService {
  readonly configured: boolean;
  /**
   * Create the external user with an email sign-in identity. Entra emails
   * nothing — our invite email (UserService) tells the user to sign in.
   * Returns the Entra object id. The random initial password is a Graph
   * API requirement only: it is never stored, logged, or returned.
   */
  createExternalUser(input: {
    readonly email: string;
    readonly displayName: string;
  }): Promise<{ readonly id: string }>;
  /** Disable (revoke) or re-enable the account. */
  setAccountEnabled(entraUserId: string, enabled: boolean): Promise<void>;
  /** Hard-delete the account. */
  deleteUser(entraUserId: string): Promise<void>;
}

export interface EntraUserServiceDeps extends EntraUserConfig {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
}

const TOKEN_SKEW_MS = 60_000;

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

function sanitizeGraphError(status: number, body: unknown): string {
  // Only the Graph error code — the body can carry PII.
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: { code?: unknown } }).error;
    if (error && typeof error.code === 'string') {
      return ` (graph: ${error.code})`;
    }
  }
  return ` (graph http ${status})`;
}

export function createEntraUserService(
  deps: EntraUserServiceDeps,
): EntraUserService {
  const {
    tenantId,
    graphClientId,
    graphClientSecret,
    issuerDomain,
    loginBaseUrl,
    graphBaseUrl,
    configured,
  } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const clock = deps.clock ?? (() => new Date());
  let tokenCache: TokenCache | null = null;
  const graphApiBase = `${graphBaseUrl}/v1.0`;

  function ensureConfigured(): void {
    if (!configured) {
      throw new HttpError(
        503,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'Account provisioning isn\u2019t available right now — the sign-in service is still being set up. Try again later.',
        false,
      );
    }
  }

  async function readJsonSafe(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function acquireToken(): Promise<string> {
    const nowMs = clock().getTime();
    if (tokenCache && tokenCache.expiresAtMs - TOKEN_SKEW_MS > nowMs) {
      return tokenCache.token;
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `${loginBaseUrl}/${tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: graphClientId,
            client_secret: graphClientSecret,
            scope: `${graphBaseUrl}/.default`,
          }).toString(),
        },
      );
    } catch {
      throw new HttpError(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'We couldn\u2019t reach the sign-in service. Try again in a moment.',
        true,
      );
    }
    if (!response.ok) {
      const body = await readJsonSafe(response);
      throw new HttpError(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        `We couldn\u2019t reach the sign-in service${sanitizeGraphError(response.status, body)}. Try again in a moment.`,
        true,
      );
    }
    const json = (await readJsonSafe(response)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!json || typeof json.access_token !== 'string') {
      throw new HttpError(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'The sign-in service returned an unexpected response. Try again in a moment.',
        true,
      );
    }
    const ttlMs =
      typeof json.expires_in === 'number' ? json.expires_in * 1000 : 3_600_000;
    tokenCache = { token: json.access_token, expiresAtMs: nowMs + ttlMs };
    return tokenCache.token;
  }

  async function graph(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    ensureConfigured();
    const token = await acquireToken();
    let response: Response;
    try {
      response = await fetchImpl(`${graphApiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new HttpError(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'We couldn\u2019t reach the sign-in service. Try again in a moment.',
        true,
      );
    }
    if (!response.ok) {
      const responseBody = await readJsonSafe(response);
      throw new HttpError(
        502,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        `The sign-in service couldn\u2019t complete that request${sanitizeGraphError(response.status, responseBody)}.`,
        true,
      );
    }
    if (response.status === 204) return null;
    return readJsonSafe(response);
  }

  return {
    configured,

    async createExternalUser(input) {
      ensureConfigured();
      // Graph requires a password on create; Entra owns the credential from
      // here on — this random value is never stored, logged, or returned.
      const oneTimePassword = randomBytes(24).toString('base64url');
      const localPart = input.email.split('@')[0] ?? 'user';
      const mailNickname =
        localPart.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || 'user';
      const created = (await graph('POST', '/users', {
        displayName: input.displayName,
        mailNickname: mailNickname || 'user',
        identities: [
          {
            signInType: 'emailAddress',
            issuer: issuerDomain,
            issuerAssignedId: input.email,
          },
        ],
        passwordProfile: {
          password: oneTimePassword,
          forceChangePasswordNextSignIn: false,
        },
        accountEnabled: true,
      })) as { id?: unknown } | null;
      if (!created || typeof created.id !== 'string') {
        throw new HttpError(
          502,
          ErrorCodes.DEPENDENCY_UNAVAILABLE,
          'The sign-in service didn\u2019t return a user id. Try again in a moment.',
          true,
        );
      }
      return { id: created.id };
    },

    async setAccountEnabled(entraUserId, enabled) {
      await graph('PATCH', `/users/${entraUserId}`, {
        accountEnabled: enabled,
      });
    },

    async deleteUser(entraUserId) {
      await graph('DELETE', `/users/${entraUserId}`);
    },
  };
}
