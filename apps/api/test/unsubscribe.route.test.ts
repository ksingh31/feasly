/**
 * Unsubscribe route tests (email/03).
 *
 * The route is thin by design: these tests pin that it validates the token
 * shape and delegates to exactly one service method — and that a malformed
 * token gets the same 403 as a forged one (no oracle).
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { createUnsubscribeRoute } from '../src/routes/unsubscribe.route';
import type { UnsubscribeService } from '../src/services/unsubscribe.service';

function fakeService(): UnsubscribeService & {
  getStateCalls: unknown[];
  unsubscribeCalls: unknown[];
} {
  const getStateCalls: unknown[] = [];
  const unsubscribeCalls: unknown[] = [];
  return {
    getStateCalls,
    unsubscribeCalls,
    buildUnsubscribeUrl: (leadId: string) =>
      `https://feasly.example/unsubscribe/token-for-${leadId}`,
    getState: async (token: string) => {
      getStateCalls.push(token);
      return { valid: true, leadId: 'lead-1', alreadyUnsubscribed: false };
    },
    unsubscribe: async (token: string) => {
      unsubscribeCalls.push(token);
      return { unsubscribed: true, alreadyUnsubscribed: false };
    },
    isUnsubscribed: async () => false,
  };
}

describe('createUnsubscribeRoute', () => {
  it('getState delegates a well-formed token to the service', async () => {
    const service = fakeService();
    const route = createUnsubscribeRoute({ unsubscribe: service });
    const result = await route.getState('some.token.here');
    expect(result).toEqual({
      valid: true,
      leadId: 'lead-1',
      alreadyUnsubscribed: false,
    });
    expect(service.getStateCalls).toEqual(['some.token.here']);
  });

  it('unsubscribe delegates a well-formed token to the service', async () => {
    const service = fakeService();
    const route = createUnsubscribeRoute({ unsubscribe: service });
    const result = await route.unsubscribe('some.token.here');
    expect(result).toEqual({ unsubscribed: true, alreadyUnsubscribed: false });
    expect(service.unsubscribeCalls).toEqual(['some.token.here']);
  });

  it('rejects non-string / empty tokens with 403 without calling the service', async () => {
    const service = fakeService();
    const route = createUnsubscribeRoute({ unsubscribe: service });
    for (const bad of ['', '   ', 42, null, undefined, {}]) {
      const error = await route
        .getState(bad)
        .then(
          () => {
            throw new Error('expected rejection');
          },
          (e: unknown) => e as { status: number; code: string },
        );
      expect(error.status).toBe(403);
      expect(error.code).toBe(ErrorCodes.FORBIDDEN);
      const error2 = await route
        .unsubscribe(bad)
        .then(
          () => {
            throw new Error('expected rejection');
          },
          (e: unknown) => e as { status: number; code: string },
        );
      expect(error2.status).toBe(403);
      expect(error2.code).toBe(ErrorCodes.FORBIDDEN);
    }
    expect(service.getStateCalls).toEqual([]);
    expect(service.unsubscribeCalls).toEqual([]);
  });

  it('propagates service rejections (forged/expired tokens) unchanged', async () => {
    const service = fakeService();
    service.getState = async () => {
      throw new HttpError(403, ErrorCodes.FORBIDDEN, 'nope');
    };
    const route = createUnsubscribeRoute({ unsubscribe: service });
    const error = await route
      .getState('forged.token.here')
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as { status: number; message: string },
      );
    expect(error.status).toBe(403);
    expect(error.message).toBe('nope');
  });
});
