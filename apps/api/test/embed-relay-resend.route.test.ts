/**
 * Embed relay-resend route tests (embed/06 AC3).
 *
 * The route is a thin adapter: it passes the body and client IP through to
 * exactly one service method and returns the result. Validation lives in
 * the service; the route adds no logic of its own.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EmbedRelayResendResponse } from '@feasly/contracts';
import { createEmbedRelayResendRoute } from '../src/routes/embed-relay-resend.route';
import type { EmbedRelayService } from '../src/services/embed-relay.service';

const RESPONSE: EmbedRelayResendResponse = {
  code: 'f'.repeat(64),
  expiresInSeconds: 600,
};

function serviceReturning(response: EmbedRelayResendResponse): EmbedRelayService {
  return {
    exchange: vi.fn(async () => {
      throw new Error('not used in these tests');
    }),
    resend: vi.fn(async () => response),
    resolveSession: vi.fn(async () => null),
  };
}

describe('embed-relay-resend route', () => {
  it('passes body and client IP to the service and returns the response', async () => {
    const service = serviceReturning(RESPONSE);
    const route = createEmbedRelayResendRoute({ relayService: service });

    const body = { code: 'c'.repeat(64), tenant_key: 'elite-craft-builders' };
    await expect(route.handle(body, '203.0.113.7')).resolves.toEqual(RESPONSE);
    expect(service.resend).toHaveBeenCalledWith(body, '203.0.113.7');
  });

  it('surfaces service errors unchanged', async () => {
    const failure = new Error('denied');
    const service: EmbedRelayService = {
      exchange: vi.fn(async () => {
        throw new Error('not used in these tests');
      }),
      resend: vi.fn(async () => {
        throw failure;
      }),
      resolveSession: vi.fn(async () => null),
    };
    const route = createEmbedRelayResendRoute({ relayService: service });

    await expect(
      route.handle({ code: 'c'.repeat(64), tenant_key: 'k' }, undefined),
    ).rejects.toBe(failure);
  });
});
