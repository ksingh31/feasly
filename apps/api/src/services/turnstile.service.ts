/**
 * #788 — Cloudflare Turnstile server-side verification.
 *
 * Implements the middleware `ChallengeVerifier` seam. Posts the token to the
 * siteverify endpoint (URL from config) with the secret from Key Vault.
 * FAILS CLOSED: any non-2xx answer, a body that isn't `success: true`, a
 * timeout or a network error returns false. It never throws.
 *
 * The secret only ever goes in the request body. It is never logged, and
 * neither is the token. Error codes from Cloudflare are logged (they are
 * fixed strings such as `invalid-input-response`).
 */
import type { ChallengeVerifier } from '../middleware/bot-challenge';

export interface TurnstileVerifierDeps {
  readonly secretKey: string;
  readonly verifyUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: (message: string) => void;
}

export function createTurnstileVerifier(deps: TurnstileVerifierDeps): ChallengeVerifier {
  const {
    secretKey,
    verifyUrl,
    timeoutMs,
    fetchImpl = fetch,
    logger = (message) => console.warn(message),
  } = deps;

  return {
    async verify(token, remoteIp) {
      if (secretKey === '' || token === '') return false;
      const form = new URLSearchParams({ secret: secretKey, response: token });
      if (remoteIp) form.set('remoteip', remoteIp);
      try {
        const res = await fetchImpl(verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          logger(`turnstile verify failed closed: status ${res.status}`);
          return false;
        }
        const body = (await res.json()) as {
          readonly success?: unknown;
          readonly 'error-codes'?: unknown;
        };
        if (body.success === true) return true;
        const codes = Array.isArray(body['error-codes'])
          ? body['error-codes'].filter((c): c is string => typeof c === 'string').join(',')
          : '';
        logger(`turnstile token rejected: ${codes || 'no error codes'}`);
        return false;
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        logger(`turnstile verify failed closed: ${name}`);
        return false;
      }
    },
  };
}
