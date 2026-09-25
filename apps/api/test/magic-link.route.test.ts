/**
 * Magic-link route tests (consumer/02).
 *
 * Thin-adapter coverage: the route validates input shape, calls exactly
 * one service method, and returns the contract response untouched. The
 * service's own semantics are covered in magic-link.service.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMagicLinkRoute } from '../src/routes/magic-link.route';
import type { MagicLinkService } from '../src/services/magic-link.service';

function fakeService(): MagicLinkService & {
  verifyCalls: unknown[];
  reissueCalls: unknown[];
} {
  const verifyCalls: unknown[] = [];
  const reissueCalls: unknown[] = [];
  return {
    verifyCalls,
    reissueCalls,
    verify: async (token: string) => {
      verifyCalls.push(token);
      return {
        valid: true,
        reportToken: token,
        estimateId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        leadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      };
    },
    reissue: async (request: unknown) => {
      reissueCalls.push(request);
      return { sent: true };
    },
  };
}

describe('magic-link route', () => {
  it('verify delegates a well-formed token query to the service', async () => {
    const service = fakeService();
    const route = createMagicLinkRoute({ magicLinks: service });
    const result = await route.verify({ token: 'abc123' });
    expect(service.verifyCalls).toEqual(['abc123']);
    // Contract shape: MagicLinkVerifyResponse (valid variant).
    expect(Object.keys(result).sort()).toEqual(
      ['estimateId', 'leadId', 'reportToken', 'valid'].sort(),
    );
    expect(result).toMatchObject({ valid: true, reportToken: 'abc123' });
  });

  it('verify answers invalid without calling the service on a missing token', async () => {
    const service = fakeService();
    const route = createMagicLinkRoute({ magicLinks: service });
    expect(await route.verify({})).toEqual({
      valid: false,
      reason: 'invalid',
      reissueAllowed: true,
    });
    expect(await route.verify({ token: '   ' })).toEqual({
      valid: false,
      reason: 'invalid',
      reissueAllowed: true,
    });
    expect(service.verifyCalls).toHaveLength(0);
  });

  it('reissue delegates the body to the service and returns its response', async () => {
    const service = fakeService();
    const route = createMagicLinkRoute({ magicLinks: service });
    const result = await route.reissue({ email: 'sam@example.com' });
    expect(service.reissueCalls).toEqual([{ email: 'sam@example.com' }]);
    expect(Object.keys(result)).toEqual(['sent']);
    expect(result).toEqual({ sent: true });
  });
});
