/**
 * Privacy route tests (legal/02). The route is a thin adapter: it extracts
 * the bearer token from headers (case-insensitive scheme per RFC 7235) and
 * calls exactly one service method. The service is faked; its own contract
 * is covered in privacy.service.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PrivacyService } from '../src/services/privacy.service';
import {
  createPrivacyRoute,
  extractBearerToken,
} from '../src/routes/privacy.route';

function deps() {
  const mocks = {
    exportMyData: vi.fn(async (token: unknown) => ({ token })),
    requestErasure: vi.fn(async (token: unknown) => ({ token })),
    confirmErasure: vi.fn(async (token: unknown, id: string) => ({
      token,
      id,
    })),
  };
  return {
    privacy: mocks as unknown as PrivacyService,
    mocks,
  };
}

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(
      extractBearerToken({ authorization: 'Bearer abc.def.ghi' }),
    ).toBe('abc.def.ghi');
  });

  it('accepts a lowercase scheme', () => {
    expect(extractBearerToken({ authorization: 'bearer token123' })).toBe(
      'token123',
    );
  });

  it.each([
    ['missing header', {}],
    ['wrong scheme', { authorization: 'Basic abc' }],
    ['no space', { authorization: 'Bearer' }],
    ['empty token', { authorization: 'Bearer   ' }],
  ])('returns undefined for %s', (_label, headers) => {
    expect(extractBearerToken(headers)).toBeUndefined();
  });

  it('takes the first value of a repeated header', () => {
    expect(
      extractBearerToken({ authorization: ['Bearer first', 'Bearer second'] }),
    ).toBe('first');
  });
});

describe('privacy route delegation', () => {
  it('passes the bearer token to the service on export', async () => {
    const d = deps();
    await createPrivacyRoute(d).exportData({
      authorization: 'Bearer t1',
    });
    expect(d.mocks.exportMyData).toHaveBeenCalledWith('t1');
  });

  it('passes undefined when no token is present (service 401s)', async () => {
    const d = deps();
    await createPrivacyRoute(d).requestErasure({});
    expect(d.mocks.requestErasure).toHaveBeenCalledWith(undefined);
  });

  it('passes the request id through on confirm', async () => {
    const d = deps();
    await createPrivacyRoute(d).confirmErasure(
      { authorization: 'Bearer t1' },
      'req-123',
    );
    expect(d.mocks.confirmErasure).toHaveBeenCalledWith('t1', 'req-123');
  });
});
