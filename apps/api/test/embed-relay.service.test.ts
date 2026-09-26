/**
 * Embed relay service tests (embed/06).
 *
 * Covers the acceptance criteria:
 * - AC1: single-use atomicity (the store enforces it; the service maps the
 *   outcome to 410 without leaking the denial reason beyond the contract).
 * - AC3: expired/used/unknown codes → 410 with the re-issue affordance.
 * - AC4: tenant mismatch → 410 (denial, not fallback).
 * - AC5: every attempt audit-logged (success + all failure modes).
 * - AC6: no PII in the response — only sessionToken, estimateId, leadScore.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createEmbedRelayService,
  type EmbedRelayServiceDeps,
} from '../src/services/embed-relay.service';
import type {
  EmbedRelayExchangeResult,
  EmbedRelayStore,
} from '../src/services/embed-relay.store';
import type { LeadStore } from '../src/services/lead.store';
import { HttpError } from '../src/middleware/errors';

const CODE =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function fakeStore(
  exchangeResult: EmbedRelayExchangeResult,
): EmbedRelayStore & { audit: ReturnType<typeof vi.fn> } {
  const audit = vi.fn(async () => {});
  return {
    issue: vi.fn(async () => {
      throw new Error('not used in these tests');
    }),
    exchange: vi.fn(async () => exchangeResult),
    audit,
  };
}

const LEADS = {
  findById: vi.fn(async (id: string) =>
    id === 'lead-1'
      ? {
          id: 'lead-1',
          estimateId: 'est-1',
          addressKey: 'addr-1',
          email: 'homeowner@example.com',
          name: 'Test Homeowner',
          phone: null,
          timeline: '3-6 months',
          marketingConsent: false,
          consentTs: new Date(),
          tenantKey: 'elite-craft-builders',
          source: 'embed',
          quarantined: false,
          leadScore: 72,
          status: 'new',
          unsubscribedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      : null,
  ),
} as unknown as LeadStore;

function depsFor(store: EmbedRelayStore): EmbedRelayServiceDeps {
  return {
    relayCodes: store,
    leads: LEADS,
    relayCodeTtlSeconds: 600,
    sessionTtlSeconds: 43_200,
    clock: () => new Date('2026-09-25T04:00:00Z'),
  };
}

const RECORD = {
  id: 'code-id-1',
  codeHash: 'hash',
  tenantKey: 'elite-craft-builders',
  userId: 'user-1',
  estimateId: 'est-1',
  leadId: 'lead-1',
  expiresAt: new Date('2026-09-25T04:10:00Z'),
  usedAt: null,
  createdAt: new Date('2026-09-25T04:00:00Z'),
};

describe('embed relay service', () => {
  it('exchanges a valid code for a session token (AC1 happy path)', async () => {
    const store = fakeStore({ ok: true, record: RECORD });
    const service = createEmbedRelayService(depsFor(store));

    const res = await service.exchange(
      { code: CODE, tenant_key: 'elite-craft-builders' },
      '203.0.113.7',
    );

    expect(res.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.estimateId).toBe('est-1');
    expect(res.leadScore).toBe(72);
    expect(res.expiresInSeconds).toBe(43_200);
    // AC6: the response carries no PII — enumerate the keys.
    expect(Object.keys(res).sort()).toEqual(
      ['estimateId', 'expiresInSeconds', 'leadScore', 'sessionToken'].sort(),
    );
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        codeId: 'code-id-1',
        tenantKey: 'elite-craft-builders',
        action: 'exchanged',
      }),
    );
    // The IP is hashed, never stored raw.
    const auditArg = store.audit.mock.calls[0]?.[0] as { ipHash: string };
    expect(auditArg.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(auditArg.ipHash).not.toContain('203.0.113.7');
  });

  it('returns 410 for an unknown code (AC3)', async () => {
    const store = fakeStore({ ok: false, reason: 'not_found' });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .exchange({ code: CODE, tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(410);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'exchange.denied', detail: 'not_found' }),
    );
  });

  it('returns 410 for an expired code (AC3)', async () => {
    const store = fakeStore({ ok: false, reason: 'expired' });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .exchange({ code: CODE, tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(410);
    expect((error as HttpError).message).toContain('fresh link');
  });

  it('returns 410 for an already-used code (AC1 replay)', async () => {
    const store = fakeStore({ ok: false, reason: 'used' });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .exchange({ code: CODE, tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(410);
  });

  it('returns 410 on tenant mismatch (AC4)', async () => {
    const store = fakeStore({ ok: true, record: RECORD });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .exchange({ code: CODE, tenant_key: 'other-builder' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(410);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'exchange.denied',
        detail: 'tenant_mismatch',
      }),
    );
  });

  it('resolves a session token issued by exchange', async () => {
    const store = fakeStore({ ok: true, record: RECORD });
    const service = createEmbedRelayService(depsFor(store));

    const res = await service.exchange(
      { code: CODE, tenant_key: 'elite-craft-builders' },
      undefined,
    );
    const ctx = await service.resolveSession(res.sessionToken);

    expect(ctx).toEqual({
      tenantKey: 'elite-craft-builders',
      estimateId: 'est-1',
      leadId: 'lead-1',
      userId: 'user-1',
    });
  });

  it('returns null for an unknown session token', async () => {
    const store = fakeStore({ ok: true, record: RECORD });
    const service = createEmbedRelayService(depsFor(store));

    await expect(service.resolveSession('nope')).resolves.toBeNull();
  });

  it('rejects a malformed code with 400 before the store is touched', async () => {
    const store = fakeStore({ ok: true, record: RECORD });
    const exchange = vi.spyOn(store, 'exchange');
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .exchange({ code: 'short', tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });
});
