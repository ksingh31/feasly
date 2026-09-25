/**
 * Embed-session route tests (embed/06).
 *
 * The route is a thin adapter: it passes the body and client IP through to
 * exactly one service method and returns the result. Validation lives in
 * the service; the route adds no logic of its own.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EmbedSessionResponse } from '@feasly/contracts';
import { createEmbedSessionRoute } from '../src/routes/embed-session.route';
import type { EmbedRelayService } from '../src/services/embed-relay.service';

const RESPONSE: EmbedSessionResponse = {
  sessionToken: 'a'.repeat(64),
  estimateId: 'est-1',
  leadScore: 72,
  expiresInSeconds: 43_200,
};

function serviceReturning(response: EmbedSessionResponse): EmbedRelayService {
  return {
    exchange: vi.fn(async () => response),
    resolveSession: vi.fn(async () => null),
  };
}

describe('embed-session route', () => {
  it('passes body and client IP to the service and returns the response', async () => {
    const service = serviceReturning(RESPONSE);
    const route = createEmbedSessionRoute({ relayService: service });

    const body = { code: 'c'.repeat(64), tenant_key: 'elite-craft-builders' };
    await expect(route.handle(body, '203.0.113.7')).resolves.toEqual(RESPONSE);
    expect(service.exchange).toHaveBeenCalledWith(body, '203.0.113.7');
  });

  it('surfaces service errors unchanged', async () => {
    const failure = new Error('denied');
    const service: EmbedRelayService = {
      exchange: vi.fn(async () => {
        throw failure;
      }),
      resolveSession: vi.fn(async () => null),
    };
    const route = createEmbedSessionRoute({ relayService: service });

    await expect(
      route.handle({ code: 'c'.repeat(64), tenant_key: 'k' }, undefined),
    ).rejects.toBe(failure);
  });
});
