/**
 * Phase-2 wiring — callback request endpoint tests.
 *
 * Service (deps faked at the interface boundary), route (service stubbed),
 * and contract-conformance: the response parses through the contracts
 * `CallbackResponse` zod schema. Semantics covered:
 * - valid request persists a lead-task row and returns { ok, window }
 * - invalid body → 400; unknown/expired report tokens → 404
 * - the report token itself is never persisted — only the leadId
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '../src/middleware/errors';
import { CallbackResponseSchema } from '../src/openapi/schemas';
import { createCallbackRoute } from '../src/routes/callback.route';
import {
  createCallbackService,
  type CallbackService,
} from '../src/services/callback.service';
import type {
  CallbackRequestRecord,
  CallbackRequestStore,
  NewCallbackRequest,
} from '../src/services/callback-request.store';
import type { LeadStore } from '../src/services/lead.store';
import type { MagicLinkStore } from '../src/services/magic-link.store';

const LEAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = 'raw-report-token';

function fakeStores(opts?: { live?: boolean }) {
  const live = opts?.live ?? true;
  const persisted: NewCallbackRequest[] = [];
  const magicLinks = {
    findByToken: async (token: string) =>
      token === TOKEN && live
        ? {
            id: 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm',
            leadId: LEAD_ID,
            purpose: 'lead',
            tokenHash: 'hash',
            email: null,
            expiresAt: new Date('2026-10-03T00:00:00Z'),
            usedAt: null,
            revokedAt: null,
            createdAt: new Date('2026-09-26T04:00:00Z'),
          }
        : null,
  } as unknown as MagicLinkStore;
  const leads = {
    findById: async (id: string) =>
      id === LEAD_ID
        ? {
            id: LEAD_ID,
            estimateId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            addressKey: 'calgary:123-elm-st',
            email: 'homeowner@example.com',
          }
        : null,
    findNewestEstimateIdByEmailAndAddress: async () => null,
  } as unknown as LeadStore;
  const callbacks: CallbackRequestStore = {
    insert: async (request: NewCallbackRequest) => {
      persisted.push(request);
      return {
        ...request,
        status: 'pending',
        createdAt: new Date('2026-09-26T05:00:00Z'),
      } as CallbackRequestRecord;
    },
    listByLeadId: async () => [],
  };
  const service: CallbackService = createCallbackService({
    magicLinks,
    leads,
    callbacks,
    clock: () => new Date('2026-09-26T05:00:00Z'),
  });
  return { service, persisted };
}

const VALID_BODY = {
  reportToken: TOKEN,
  name: 'Home Owner',
  phone: '403-555-0100',
  window: 'evening',
};

describe('callback service', () => {
  it('persists a lead-task row and returns the window', async () => {
    const { service, persisted } = fakeStores();
    const result = await service.requestCallback(VALID_BODY);
    expect(result).toEqual({ ok: true, window: 'evening' });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      leadId: LEAD_ID,
      name: 'Home Owner',
      phone: '403-555-0100',
      window: 'evening',
    });
    // The Bearer <redacted> is never persisted — only the lead id.
    expect(JSON.stringify(persisted[0])).not.toContain(TOKEN);
  });

  it('trims the name and phone', async () => {
    const { service, persisted } = fakeStores();
    await service.requestCallback({ ...VALID_BODY, name: '  Jo  ', phone: ' 403-555-0100 ' });
    expect(persisted[0]?.name).toBe('Jo');
    expect(persisted[0]?.phone).toBe('403-555-0100');
  });

  it('rejects invalid bodies', async () => {
    const { service, persisted } = fakeStores();
    for (const body of [
      {},
      { ...VALID_BODY, window: 'sometime' },
      { ...VALID_BODY, name: '' },
      { ...VALID_BODY, phone: '123' },
      { ...VALID_BODY, reportToken: '' },
    ]) {
      await expect(service.requestCallback(body)).rejects.toMatchObject({
        status: 400,
        code: ErrorCodes.VALIDATION_FAILED,
      });
    }
    expect(persisted).toHaveLength(0);
  });

  it('answers 404 for unknown report tokens', async () => {
    const { service } = fakeStores({ live: false });
    await expect(service.requestCallback(VALID_BODY)).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });
});

describe('callback route', () => {
  it('delegates to the callback service', async () => {
    const { service } = fakeStores();
    const route = createCallbackRoute({ callbacks: service });
    const result = await route.handle(VALID_BODY);
    expect(result).toEqual({ ok: true, window: 'evening' });
  });
});

describe('callback contract conformance', () => {
  it('the route response validates against the contracts CallbackResponse schema', async () => {
    const { service } = fakeStores();
    const route = createCallbackRoute({ callbacks: service });
    const result = await route.handle(VALID_BODY);
    expect(
      CallbackResponseSchema.safeParse(JSON.parse(JSON.stringify(result))).success,
    ).toBe(true);
  });
});
