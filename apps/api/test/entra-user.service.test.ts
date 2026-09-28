/**
 * EntraUserService tests (auth/01) — Graph API is fully mocked. The real
 * tenant is being created in parallel, so there is deliberately no
 * integration test here yet.
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/middleware/errors';
import {
  createEntraUserService,
  type EntraUserConfig,
} from '../src/services/entra-user.service';

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

const CONFIG: EntraUserConfig = {
  tenantId: 'tenant-123',
  graphClientId: 'client-456',
  graphClientSecret: 'super-secret-value',
  issuerDomain: 'feaslyexternal.onmicrosoft.com',
  configured: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(
  handler: (req: RecordedRequest) => Response | Promise<Response>,
): typeof fetch {
  const requests: RecordedRequest[] = [];
  const impl = (async (url: unknown, init?: unknown) => {
    const req = { url: String(url), init: (init ?? {}) as RequestInit };
    requests.push(req);
    return handler(req);
  }) as typeof fetch;
  (impl as unknown as { requests: RecordedRequest[] }).requests = requests;
  return impl;
}

function requestsOf(impl: typeof fetch): RecordedRequest[] {
  return (impl as unknown as { requests: RecordedRequest[] }).requests;
}

function graphHandler() {
  return mockFetch((req) => {
    if (req.url.includes('/oauth2/v2.0/token')) {
      return jsonResponse({ access_token: 'token-abc', expires_in: 3600 });
    }
    if (req.url.endsWith('/v1.0/users') && req.init.method === 'POST') {
      return jsonResponse({ id: 'entra-object-id-1' }, 201);
    }
    // 204 responses must not carry a body — the Response constructor throws.
    return new Response(null, { status: 204 });
  });
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    return error as HttpError;
  }
  throw new Error(`expected an HttpError with status ${status}`);
}

describe('EntraUserService', () => {
  it('acquires a token via client credentials and creates the user', async () => {
    const fetchImpl = graphHandler();
    const svc = createEntraUserService({ ...CONFIG, fetchImpl });

    const created = await svc.createExternalUser({
      email: 'ada@example.com',
      displayName: 'Ada Admin',
    });

    expect(created.id).toBe('entra-object-id-1');
    const reqs = requestsOf(fetchImpl);
    expect(reqs).toHaveLength(2);

    const tokenReq = reqs[0]!;
    expect(tokenReq.url).toContain('/tenant-123/oauth2/v2.0/token');
    const tokenBody = new URLSearchParams(String(tokenReq.init.body));
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_id')).toBe('client-456');
    expect(tokenBody.get('client_secret')).toBe('super-secret-value');
    expect(tokenBody.get('scope')).toBe('https://graph.microsoft.com/.default');

    const createReq = reqs[1]!;
    expect(createReq.url).toBe('https://graph.microsoft.com/v1.0/users');
    expect(createReq.init.method).toBe('POST');
    expect(
      (createReq.init.headers as Record<string, string>)['Authorization'],
    ).toBe('Bearer token-abc');
    const payload = JSON.parse(String(createReq.init.body)) as {
      displayName: string;
      mailNickname: string;
      identities: {
        signInType: string;
        issuer: string;
        issuerAssignedId: string;
      }[];
      passwordProfile: {
        password: string;
        forceChangePasswordNextSignIn: boolean;
      };
      accountEnabled: boolean;
    };
    expect(payload.displayName).toBe('Ada Admin');
    expect(payload.identities).toEqual([
      {
        signInType: 'emailAddress',
        issuer: 'feaslyexternal.onmicrosoft.com',
        issuerAssignedId: 'ada@example.com',
      },
    ]);
    // Graph requires a password on create; it must be random per call and
    // never echoed back in the service result.
    expect(typeof payload.passwordProfile.password).toBe('string');
    expect(payload.passwordProfile.password.length).toBeGreaterThanOrEqual(16);
    expect(payload.accountEnabled).toBe(true);
  });

  it('caches the access token across calls', async () => {
    const fetchImpl = graphHandler();
    const svc = createEntraUserService({ ...CONFIG, fetchImpl });

    await svc.createExternalUser({ email: 'a@example.com', displayName: 'A' });
    await svc.createExternalUser({ email: 'b@example.com', displayName: 'B' });

    const tokenReqs = requestsOf(fetchImpl).filter((r) =>
      r.url.includes('/oauth2/v2.0/token'),
    );
    expect(tokenReqs).toHaveLength(1);
  });

  it('refreshes the token after expiry', async () => {
    let now = new Date('2026-09-27T18:00:00Z');
    const fetchImpl = graphHandler();
    const svc = createEntraUserService({
      ...CONFIG,
      fetchImpl,
      clock: () => now,
    });

    await svc.createExternalUser({ email: 'a@example.com', displayName: 'A' });
    now = new Date(now.getTime() + 2 * 3600 * 1000);
    await svc.createExternalUser({ email: 'b@example.com', displayName: 'B' });

    const tokenReqs = requestsOf(fetchImpl).filter((r) =>
      r.url.includes('/oauth2/v2.0/token'),
    );
    expect(tokenReqs).toHaveLength(2);
  });

  it('disables / enables / deletes the account', async () => {
    const fetchImpl = graphHandler();
    const svc = createEntraUserService({ ...CONFIG, fetchImpl });

    await svc.setAccountEnabled('entra-object-id-1', false);
    await svc.setAccountEnabled('entra-object-id-1', true);
    await svc.deleteUser('entra-object-id-1');

    const graphReqs = requestsOf(fetchImpl).filter((r) =>
      r.url.startsWith('https://graph.microsoft.com'),
    );
    expect(graphReqs).toHaveLength(3);
    expect(graphReqs[0]!.url).toBe(
      'https://graph.microsoft.com/v1.0/users/entra-object-id-1',
    );
    expect(graphReqs[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(graphReqs[0]!.init.body))).toEqual({
      accountEnabled: false,
    });
    expect(JSON.parse(String(graphReqs[1]!.init.body))).toEqual({
      accountEnabled: true,
    });
    expect(graphReqs[2]!.init.method).toBe('DELETE');
  });

  it('maps Graph errors to a sanitized 502 (no secret leaks)', async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.url.includes('/oauth2/v2.0/token')) {
        return jsonResponse({ access_token: 't', expires_in: 3600 });
      }
      return jsonResponse(
        {
          error: {
            code: 'Request_BadRequest',
            message: 'Something with ada@example.com went wrong',
          },
        },
        400,
      );
    });
    const svc = createEntraUserService({ ...CONFIG, fetchImpl });

    const error = await expectHttpError(
      svc.createExternalUser({ email: 'ada@example.com', displayName: 'Ada' }),
      502,
    );
    expect(error.code).toBe('DEPENDENCY_UNAVAILABLE');
    // The Graph error code is fine; PII and the secret are not.
    expect(error.message).toContain('Request_BadRequest');
    expect(error.message).not.toContain('super-secret-value');
    expect(error.message).not.toContain('ada@example.com');
  });

  it('maps token-endpoint failures and network errors to 502', async () => {
    const badToken = mockFetch((req) => {
      if (req.url.includes('/oauth2/v2.0/token')) {
        return jsonResponse({ error: 'invalid_client' }, 401);
      }
      return jsonResponse({}, 204);
    });
    const svc = createEntraUserService({ ...CONFIG, fetchImpl: badToken });
    await expectHttpError(svc.setAccountEnabled('x', false), 502);

    const networkDown = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const svc2 = createEntraUserService({ ...CONFIG, fetchImpl: networkDown });
    const error = await expectHttpError(svc2.deleteUser('x'), 502);
    expect(error.retryable).toBe(true);
  });

  it('fails closed with a clear 503 when the tenant is not configured', async () => {
    const fetchImpl = graphHandler();
    const svc = createEntraUserService({
      ...CONFIG,
      configured: false,
      fetchImpl,
    });
    expect(svc.configured).toBe(false);

    const error = await expectHttpError(
      svc.createExternalUser({ email: 'a@example.com', displayName: 'A' }),
      503,
    );
    expect(error.message).toContain('still being set up');
    await expectHttpError(svc.setAccountEnabled('x', false), 503);
    await expectHttpError(svc.deleteUser('x'), 503);
    // No HTTP request should have been attempted at all.
    expect(requestsOf(fetchImpl)).toHaveLength(0);
  });
});
