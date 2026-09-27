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
  EmbedRelayCodeRecord,
  EmbedRelayExchangeResult,
  EmbedRelayStore,
} from '../src/services/embed-relay.store';
import type { LeadStore } from '../src/services/lead.store';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

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
    findByHash: vi.fn(async () => {
      throw new Error('not used in these tests');
    }),
    countRecentResends: vi.fn(async () => 0),
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
    relayResendCooldownSeconds: 60,
    clock: () => new Date('2026-09-25T04:00:00Z'),
  };
}

const RECORD: EmbedRelayCodeRecord = {
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

describe('embed relay service — resend (embed/06 AC3)', () => {
  const NEW_CODE =
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  const EXPIRED_RECORD = {
    ...RECORD,
    expiresAt: new Date('2026-09-25T03:50:00Z'),
  };
  const USED_RECORD = {
    ...RECORD,
    usedAt: new Date('2026-09-25T03:55:00Z'),
  };

  function resendStore(opts: {
    record: typeof RECORD | null;
    recentResends?: number;
  }): EmbedRelayStore & {
    audit: ReturnType<typeof vi.fn>;
    issue: ReturnType<typeof vi.fn>;
  } {
    const audit = vi.fn(async () => {});
    const issue = vi.fn(async () => ({
      id: 'new-code-id',
      code: NEW_CODE,
      expiresAt: new Date('2026-09-25T04:10:00Z'),
    }));
    return {
      issue,
      exchange: vi.fn(async () => {
        throw new Error('not used in these tests');
      }),
      findByHash: vi.fn(async () => opts.record),
      countRecentResends: vi.fn(async () => opts.recentResends ?? 0),
      audit,
    };
  }

  it('re-issues a fresh code for an expired code (AC3)', async () => {
    const store = resendStore({ record: EXPIRED_RECORD });
    const service = createEmbedRelayService(depsFor(store));

    const res = await service.resend(
      { code: CODE, tenant_key: 'elite-craft-builders' },
      '203.0.113.7',
    );

    expect(res.code).toBe(NEW_CODE);
    expect(res.expiresInSeconds).toBe(600);
    // AC6: the response carries no PII — enumerate the keys.
    expect(Object.keys(res).sort()).toEqual(['code', 'expiresInSeconds']);
    // The new code inherits the old code's context.
    expect(store.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantKey: 'elite-craft-builders',
        userId: 'user-1',
        estimateId: 'est-1',
        leadId: 'lead-1',
        ttlSeconds: 600,
      }),
    );
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        codeId: 'code-id-1',
        tenantKey: 'elite-craft-builders',
        action: 'relay.resent',
        detail: 'issued=new-code-id',
      }),
    );
    const auditArg = store.audit.mock.calls[0]?.[0] as { ipHash: string };
    expect(auditArg.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(auditArg.ipHash).not.toContain('203.0.113.7');
  });

  it('re-issues a fresh code for an already-used code (AC3 replay affordance)', async () => {
    const store = resendStore({ record: USED_RECORD });
    const service = createEmbedRelayService(depsFor(store));

    const res = await service.resend(
      { code: CODE, tenant_key: 'elite-craft-builders' },
      undefined,
    );

    expect(res.code).toBe(NEW_CODE);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.resent' }),
    );
  });

  it('returns 410 for an unknown code (AC3 — uniform denial)', async () => {
    const store = resendStore({ record: null });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .resend({ code: CODE, tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(410);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.resend_denied', detail: 'not_found' }),
    );
    expect(store.issue).not.toHaveBeenCalled();
  });

  it('returns 410 on tenant mismatch (AC4 — denial, not fallback)', async () => {
    const store = resendStore({ record: EXPIRED_RECORD });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .resend({ code: CODE, tenant_key: 'other-builder' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(410);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.resend_denied',
        detail: 'tenant_mismatch',
      }),
    );
    expect(store.issue).not.toHaveBeenCalled();
  });

  it('returns 410 for a still-valid code (resend is for expired/used only)', async () => {
    const store = resendStore({ record: RECORD });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .resend({ code: CODE, tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(410);
    expect((error as HttpError).message).toContain('still valid');
    expect(store.issue).not.toHaveBeenCalled();
  });

  it('returns 429 inside the 60s per-code cooldown (AC3 rate limit)', async () => {
    const store = resendStore({ record: EXPIRED_RECORD, recentResends: 1 });
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .resend({ code: CODE, tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).code).toBe(ErrorCodes.RATE_LIMITED);
    expect(store.issue).not.toHaveBeenCalled();
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.resend_denied',
        detail: 'cooldown',
      }),
    );
  });

  it('blocks the second resend inside 60s — the cooldown sees the audit (AC3)', async () => {
    // Stateful fake: the cooldown count derives from audit rows, like the
    // real Drizzle store. This proves the success audit lands on the same
    // code id the cooldown looks up.
    const auditRows: Array<{ codeId: string | null; action: string }> = [];
    const store = {
      issue: vi.fn(async () => ({
        id: 'new-code-id',
        code: NEW_CODE,
        expiresAt: new Date('2026-09-25T04:10:00Z'),
      })),
      exchange: vi.fn(async () => {
        throw new Error('not used in these tests');
      }),
      findByHash: vi.fn(async () => EXPIRED_RECORD),
      countRecentResends: vi.fn(async (codeId: string) =>
        auditRows.filter(
          (r) => r.codeId === codeId && r.action === 'relay.resent',
        ).length,
      ),
      audit: vi.fn(async (row: { codeId: string | null; action: string }) => {
        auditRows.push(row);
      }),
    };
    const service = createEmbedRelayService(depsFor(store));

    const body = { code: CODE, tenant_key: 'elite-craft-builders' };
    const first = await service.resend(body, undefined);
    expect(first.code).toBe(NEW_CODE);

    const error = await service.resend(body, undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).code).toBe(ErrorCodes.RATE_LIMITED);
    // The second attempt issued nothing new.
    expect(store.issue).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed code with 400 before the store is touched', async () => {
    const store = resendStore({ record: EXPIRED_RECORD });
    const findByHash = vi.spyOn(store, 'findByHash');
    const service = createEmbedRelayService(depsFor(store));

    const error = await service
      .resend({ code: 'short', tenant_key: 'elite-craft-builders' }, undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect(findByHash).not.toHaveBeenCalled();
  });
});
