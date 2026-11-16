/**
 * BuilderSettingsService unit tests (#870). Builders, store, audit and
 * email are faked at their interfaces; PGlite coverage lives in
 * builder-settings.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Builder } from '@feasly/contracts';
import {
  createBuilderSettingsService,
  type BuilderSettingsActor,
} from '../src/services/builder-settings.service';
import type {
  BuilderSettingsStore,
  OriginChangeRequestRecord,
} from '../src/services/builder-settings.store';
import { HttpError } from '../src/middleware/errors';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;

function builder(overrides: Partial<Builder> = {}): Builder {
  return {
    id: 'b-1',
    tenantKey: 'builder-a',
    businessName: 'Builder A Ltd.',
    displayName: 'Builder A',
    email: null,
    phone: null,
    logoUrl: null,
    accentColor: null,
    allowedOrigins: ['https://www.builder-a.example'],
    plan: 'commission',
    status: 'active',
    settings: {},
    commissionRatePercent: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const OWNER: BuilderSettingsActor = {
  builderId: 'b-1',
  userId: 'u-1',
  email: 'owner@builder-a.example',
  canEdit: true,
};
const MEMBER: BuilderSettingsActor = { ...OWNER, email: 'member@builder-a.example', canEdit: false };

function setup(opts: { builder?: Builder; emailThrows?: boolean } = {}) {
  const b = opts.builder ?? builder();
  const records: OriginChangeRequestRecord[] = [];
  const keys = new Map<string, OriginChangeRequestRecord>();
  const closures: Array<{ id: string; createdAt: Date }> = [];
  const store: BuilderSettingsStore = {
    createOriginRequest: vi.fn(async (input) => {
      const existing = keys.get(input.dedupeKey);
      if (existing) return { record: existing, created: false };
      const record: OriginChangeRequestRecord = {
        id: `r-${records.length + 1}`,
        builderId: input.builderId,
        status: 'open',
        add: input.add,
        remove: input.remove,
        note: input.note,
        createdAt: NOW,
      };
      records.push(record);
      keys.set(input.dedupeKey, record);
      return { record, created: true };
    }),
    listOpenOriginRequests: vi.fn(async () => records),
    markOriginRequestsDone: vi.fn(async (ids) => ids.length),
    lastEmbedLoads: vi.fn(async () => []),
    createClosureRequest: vi.fn(async () => {
      const created = closures.length === 0;
      if (created) closures.push({ id: `c-${closures.length + 1}`, createdAt: NOW });
      return { record: closures[0]!, created };
    }),
  };
  const builders = {
    getBuilder: vi.fn(async () => b),
    updateProfile: vi.fn(async (_id: string, patch: Record<string, unknown>) =>
      builder({ ...(patch as Partial<Builder>) }),
    ),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const email = {
    sendOpsAlert: vi.fn(async () => {
      if (opts.emailThrows) throw new Error('provider down');
      return { sent: true as const, provider: 'log' as const };
    }),
  };
  const warnings: string[] = [];
  const service = createBuilderSettingsService({
    builders,
    store,
    audit,
    email,
    clock: () => NOW,
    logWarning: (m) => warnings.push(m),
    config: {
      supportEmail: 'help@support.example',
      supportResponseTime: 'within 1 business day',
      embedLiveWindowDays: 7,
      embedLoaderUrl: 'https://app.example/embed/v1/loader.js',
      opsInbox: 'team@ops.example',
      appBaseUrl: 'https://app.example/',
    },
  });
  return { service, store, builders, audit, email, warnings, records };
}

async function httpError(p: Promise<unknown>): Promise<HttpError> {
  const e = await p.then(() => null, (err: unknown) => err);
  if (!(e instanceof HttpError)) throw new Error('expected an HttpError');
  return e;
}

describe('builder settings service — profile', () => {
  it('returns the profile, canEdit and the configured support contact', async () => {
    const { service } = setup();
    const res = await service.getProfile(MEMBER);
    expect(res.canEdit).toBe(false);
    expect(res.support).toEqual({
      channel: 'email',
      email: 'help@support.example',
      responseTime: 'within 1 business day',
    });
    // Rate, plan and status never appear in the payload.
    const json = JSON.stringify(res);
    expect(json).not.toContain('commission');
    expect(json).not.toContain('plan');
    expect(json).not.toContain('status');
  });

  it('403s a member update before touching the builder', async () => {
    const { service, builders } = setup();
    const e = await httpError(service.updateProfile(MEMBER, { displayName: 'X' }));
    expect(e.status).toBe(403);
    expect(builders.updateProfile).not.toHaveBeenCalled();
  });

  it('maps fields, normalizes, and clears with null or blank', async () => {
    const { service, builders } = setup();
    await service.updateProfile(OWNER, {
      displayName: '  New Name ',
      contactEmail: '',
      contactPhone: null,
      logoUrl: 'https://cdn.example/logo.svg',
      accentColor: '#ABCDEF',
    });
    expect(builders.updateProfile).toHaveBeenCalledWith(
      'b-1',
      {
        displayName: 'New Name',
        email: null,
        phone: null,
        logoUrl: 'https://cdn.example/logo.svg',
        accentColor: '#abcdef',
      },
      'owner@builder-a.example',
    );
  });

  it.each([
    [{ accentColor: 'red' }, 'accentColor'],
    [{ accentColor: '#12345' }, 'accentColor'],
    [{ logoUrl: 'http://cdn.example/logo.png' }, 'logoUrl'],
    [{ logoUrl: 'javascript:alert(1)' }, 'logoUrl'],
    [{ contactEmail: 'nope' }, 'contactEmail'],
    [{ contactPhone: 'call me' }, 'contactPhone'],
    [{ displayName: '' }, 'displayName'],
    [{ commissionRatePercent: 0 }, 'body'],
    [{ allowedOrigins: ['https://a.example'] }, 'body'],
  ])('400s invalid input %j', async (body, _field) => {
    const { service, builders } = setup();
    const e = await httpError(service.updateProfile(OWNER, body));
    expect(e.status).toBe(400);
    // Never echoes the submitted value.
    expect(e.message).not.toContain('javascript');
    expect(builders.updateProfile).not.toHaveBeenCalled();
  });

  it('400s an empty update', async () => {
    const { service } = setup();
    expect((await httpError(service.updateProfile(OWNER, {}))).status).toBe(400);
  });
});

describe('builder settings service — embed', () => {
  it('flags each origin loaded within the live window and hides applied requests', async () => {
    const b = builder({
      allowedOrigins: ['https://www.builder-a.example', 'https://old.builder-a.example', 'https://new.builder-a.example'],
    });
    const { service, store, records } = setup({ builder: b });
    vi.mocked(store.lastEmbedLoads).mockResolvedValue([
      { origin: 'https://www.builder-a.example', lastSeenAt: new Date(NOW.getTime() - 7 * DAY) },
      { origin: 'https://old.builder-a.example', lastSeenAt: new Date(NOW.getTime() - 7 * DAY - 1) },
    ]);
    records.push(
      { id: 'r-applied', builderId: 'b-1', status: 'open', add: ['https://new.builder-a.example'], remove: [], note: null, createdAt: NOW },
      { id: 'r-pending', builderId: 'b-1', status: 'open', add: ['https://later.builder-a.example'], remove: [], note: null, createdAt: NOW },
    );
    const res = await service.getEmbed(OWNER);
    expect(res.origins).toEqual([
      { origin: 'https://www.builder-a.example', lastSeenAt: new Date(NOW.getTime() - 7 * DAY).toISOString(), loadedRecently: true },
      { origin: 'https://old.builder-a.example', lastSeenAt: new Date(NOW.getTime() - 7 * DAY - 1).toISOString(), loadedRecently: false },
      { origin: 'https://new.builder-a.example', lastSeenAt: null, loadedRecently: false },
    ]);
    expect(res.openRequests.map((r) => r.id)).toEqual(['r-pending']);
    expect(res.snippet).toBe(
      '<script src="https://app.example/embed/v1/loader.js"\n        data-builder="builder-a"></script>',
    );
    expect(store.lastEmbedLoads).toHaveBeenCalledWith('builder-a', b.allowedOrigins);
  });

  it('reports "never seen" for a new builder', async () => {
    const { service } = setup();
    const res = await service.getEmbed(MEMBER);
    expect(res.lastSeenAt).toBeNull();
    expect(res.origins).toEqual([
      { origin: 'https://www.builder-a.example', lastSeenAt: null, loadedRecently: false },
    ]);
  });
});

describe('builder settings service — origin requests', () => {
  it('creates exactly one task, audits and notifies once for repeated identical requests', async () => {
    const { service, audit, email, records } = setup();
    const a = await service.requestOriginChange(OWNER, {
      add: ['https://Staging.Builder-A.example/', 'https://staging.builder-a.example'],
    });
    // Same set, different order/casing → same task.
    const b = await service.requestOriginChange(OWNER, { add: ['https://staging.builder-a.example'], note: 'again' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(records).toHaveLength(1);
    expect(a.request.add).toEqual(['https://staging.builder-a.example']);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'builder_origin_change_requested', actorEmail: 'owner@builder-a.example' }),
    );
    expect(email.sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(email.sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'team@ops.example',
        detailsUrl: 'https://app.example/admin/builders',
        summary: expect.stringContaining('add https://staging.builder-a.example'),
      }),
    );
  });

  it('still records the task when the notice email fails', async () => {
    const { service, records, warnings } = setup({ emailThrows: true });
    const res = await service.requestOriginChange(OWNER, { remove: ['https://www.builder-a.example'] });
    expect(res.created).toBe(true);
    expect(records).toHaveLength(1);
    expect(warnings.join(' ')).toContain('origin-request notice failed');
  });

  it('403s members', async () => {
    const { service, records } = setup();
    const e = await httpError(service.requestOriginChange(MEMBER, { add: ['https://a.example'] }));
    expect(e.status).toBe(403);
    expect(records).toHaveLength(0);
  });

  it.each([
    [{}],
    [{ add: [], remove: [] }],
    [{ add: ['http://staging.example'] }],
    [{ add: ['https://staging.example/page'] }],
    [{ add: ['https://staging.example?x=1'] }],
    [{ add: ['not a url'] }],
    [{ add: ['https://www.builder-a.example'] }], // already allowed
    [{ remove: ['https://unknown.example'] }], // not allowed
    [{ add: ['https://x.example'], remove: ['https://x.example'] }],
    [{ add: Array.from({ length: 11 }, (_, i) => `https://s${i}.example`) }],
    [{ add: ['https://x.example'], note: 'n'.repeat(501) }],
    [{ add: ['https://x.example'], extra: true }],
  ])('400s %j', async (body) => {
    const { service, records } = setup();
    const e = await httpError(service.requestOriginChange(OWNER, body));
    expect(e.status).toBe(400);
    expect(records).toHaveLength(0);
  });

  it('closes only the requests an admin update satisfied', async () => {
    const { service, store, records } = setup();
    records.push(
      { id: 'r-1', builderId: 'b-1', status: 'open', add: ['https://a.example'], remove: ['https://old.example'], note: null, createdAt: NOW },
      { id: 'r-2', builderId: 'b-1', status: 'open', add: ['https://b.example'], remove: [], note: null, createdAt: NOW },
    );
    const n = await service.resolveSatisfiedOriginRequests({
      builderId: 'b-1',
      allowedOrigins: ['https://a.example'],
      actorEmail: 'staff@feasly.example',
    });
    expect(n).toBe(1);
    expect(store.markOriginRequestsDone).toHaveBeenCalledWith(['r-1'], 'staff@feasly.example', NOW);
  });
});

describe('builder settings service — account closure request (#860)', () => {
  it('files one admin task, audits and emails the team inbox once', async () => {
    const { service, store, audit, email } = setup();
    const first = await service.requestAccountClosure(OWNER, { reason: 'Retiring' });
    const second = await service.requestAccountClosure(OWNER, {});
    expect(first).toEqual({ requestId: 'c-1', created: true, requestedAt: NOW.toISOString() });
    expect(second.created).toBe(false);
    expect(store.createClosureRequest).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Retiring', requestedByEmail: OWNER.email }),
    );
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'builder_account_closure_requested' }),
    );
    expect(email.sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(email.sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'team@ops.example' }),
    );
  });

  it('still records the request when the notice fails', async () => {
    const { service, warnings } = setup({ emailThrows: true });
    const out = await service.requestAccountClosure(OWNER, {});
    expect(out.created).toBe(true);
    expect(warnings.join(' ')).toMatch(/closure notice failed/);
  });

  it('403s members and 400s an over-long or unknown body', async () => {
    const { service, store } = setup();
    expect((await httpError(service.requestAccountClosure(MEMBER, {}))).status).toBe(403);
    expect(
      (await httpError(service.requestAccountClosure(OWNER, { reason: 'x'.repeat(1001) }))).status,
    ).toBe(400);
    expect((await httpError(service.requestAccountClosure(OWNER, { other: 1 }))).status).toBe(400);
    expect(store.createClosureRequest).not.toHaveBeenCalled();
  });
});
