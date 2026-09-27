/**
 * Unsubscribe service tests (email/03).
 *
 * Covers the story's acceptance criteria at the service boundary:
 * - AC1: a token for lead A unsubscribes lead A only; forged → 403.
 * - AC2: expired token → friendly error, no state change.
 * - Idempotency: re-clicking keeps the FIRST opt-out timestamp.
 * - isUnsubscribed: the suppression check email/02's nudge timer uses.
 * - Fail-closed: no secret configured → every operation names the variable.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '../src/middleware/errors';
import type { LeadRecord, LeadStore } from '../src/services/lead.store';
import {
  createUnsubscribeService,
  type UnsubscribeServiceDeps,
} from '../src/services/unsubscribe.service';
import { issueUnsubscribeToken } from '../src/services/unsubscribe-token';

const SECRET = 'test-secret-please-ignore';
const TTL = 2_592_000;
const NOW = new Date('2026-09-25T00:00:00.000Z');
const LEAD_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_LEAD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function leadRecord(id: string): LeadRecord {
  return {
    id,
    estimateId: 'e0000000-0000-4000-8000-000000000000',
    addressKey: 'calgary-123-fake-st-nw',
    email: 'sam@example.com',
    name: 'Sam',
    phone: null,
    timeline: 'exploring',
    marketingConsent: true,
    consentTs: NOW,
    tenantKey: null,
    source: 'web',
    quarantined: false,
    sandbox: false,
    leadScore: 0,
    status: 'new',
    unsubscribedAt: null,
    contactOptOutAt: null,
    consentUpdatedAt: NOW,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: NOW,
    createdAt: NOW,
  };
}

interface World {
  records: Map<string, LeadRecord>;
  setUnsubscribedAtCalls: Array<{ id: string; at: Date }>;
}

function fakeStore(world: World): LeadStore {
  return {
    findRecentByEmailAndAddress: async () => null,
    listLeads: async () => [...world.records.values()],
    insert: async () => {
      throw new Error('not used');
    },
    updateOnRepeat: async () => {
      throw new Error('not used');
    },
    findNewestEstimateIdByEmailAndAddress: async () => null,
    findById: async (id: string) => world.records.get(id) ?? null,
    findByEstimateId: async () => null,
    setUnsubscribedAt: async (args: { id: string; at: Date }) => {
      world.setUnsubscribedAtCalls.push(args);
      const record = world.records.get(args.id);
      if (!record) return null;
      // Mirror the real store: first opt-out timestamp wins.
      const stamped = record.unsubscribedAt ?? args.at;
      const updated = { ...record, unsubscribedAt: stamped };
      world.records.set(args.id, updated);
      return updated;
    },
    findNudgeCandidates: async () => [],
    setNudgeSentAt: async () => null,
    findAllByEmail: async () => [],
    deleteByEmail: async () => 0,
    findSheetsSyncCandidates: async () => [],
    setSheetsSyncedAt: async () => null,
    countNeverSynced: async () => 0,
      listByTenantKey: async () => [],
      updateStatus: async () => null,
      updateConsentPreferences: async (args: {
        id: string;
        emailOptOut?: boolean;
        contactOptOut?: boolean;
        at: Date;
      }) => {
        const record = world.records.get(args.id);
        if (!record) return null;
        // Mirror the real store: first opt-out timestamp wins; opting back
        // in clears the timestamp; consentUpdatedAt moves only on change.
        let { unsubscribedAt, contactOptOutAt } = record;
        let changed = false;
        if (args.emailOptOut !== undefined) {
          const next = args.emailOptOut ? (unsubscribedAt ?? args.at) : null;
          if (next !== unsubscribedAt) {
            unsubscribedAt = next;
            changed = true;
          }
        }
        if (args.contactOptOut !== undefined) {
          const next = args.contactOptOut ? (contactOptOutAt ?? args.at) : null;
          if (next !== contactOptOutAt) {
            contactOptOutAt = next;
            changed = true;
          }
        }
        const updated = {
          ...record,
          unsubscribedAt,
          contactOptOutAt,
          consentUpdatedAt: changed ? args.at : record.consentUpdatedAt,
        };
        world.records.set(args.id, updated);
        return updated;
      },
    appendNote: async () => {},
    getNotes: async () => [],
    appendStatusHistory: async () => {},
    getStatusHistory: async () => [],
  };
}

function deps(world: World, overrides?: Partial<UnsubscribeServiceDeps>) {
  return createUnsubscribeService({
    leads: fakeStore(world),
    unsubscribeUrlBase: 'https://feasly.example/unsubscribe',
    tokenSecret: SECRET,
    tokenTtlSeconds: TTL,
    clock: () => NOW,
    ...overrides,
  });
}

function worldWithLead(id = LEAD_ID): World {
  return {
    records: new Map([[id, leadRecord(id)]]),
    setUnsubscribedAtCalls: [],
  };
}

function tokenFor(id: string, secret = SECRET, now: Date = NOW): string {
  return issueUnsubscribeToken({ leadId: id, secret, now });
}

async function expectForbidden(promise: Promise<unknown>, message: string) {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e as { status: number; code: string; message: string },
  );
  expect(error.status).toBe(403);
  expect(error.code).toBe(ErrorCodes.FORBIDDEN);
  expect(error.message).toBe(message);
}

describe('UnsubscribeService', () => {
  describe('getState', () => {
    it('returns the valid state for a fresh token (not yet unsubscribed)', async () => {
      const service = deps(worldWithLead());
      const state = await service.getState(tokenFor(LEAD_ID));
      expect(state).toEqual({
        valid: true,
        leadId: LEAD_ID,
        emailOptedOut: false,
        contactOptedOut: false,
        consentUpdatedAt: expect.any(String),
        alreadyUnsubscribed: false,
      });
    });

    it('reports alreadyUnsubscribed after the opt-out', async () => {
      const world = worldWithLead();
      const service = deps(world);
      await service.unsubscribe(tokenFor(LEAD_ID));
      const state = await service.getState(tokenFor(LEAD_ID));
      expect(state).toEqual({
        valid: true,
        leadId: LEAD_ID,
        emailOptedOut: true,
        contactOptedOut: false,
        consentUpdatedAt: expect.any(String),
        alreadyUnsubscribed: true,
      });
    });

    it('AC1: a forged token is rejected with 403 (no oracle for lead IDs)', async () => {
      const service = deps(worldWithLead());
      await expectForbidden(
        service.getState(tokenFor(LEAD_ID, 'wrong-secret')),
        'This unsubscribe link is not valid.',
      );
    });

    it('AC2: an expired token is rejected with the refresh-path message, no state change', async () => {
      const world = worldWithLead();
      const service = deps(world);
      const issued = new Date(NOW.getTime() - (TTL + 60) * 1000);
      await expectForbidden(
        service.getState(tokenFor(LEAD_ID, SECRET, issued)),
        'This unsubscribe link has expired. Request a fresh link from any Feasly email.',
      );
      expect(world.setUnsubscribedAtCalls).toEqual([]);
    });

    it('a token for an unknown lead is rejected with 403 (no oracle)', async () => {
      const service = deps(worldWithLead());
      await expectForbidden(
        service.getState(tokenFor(OTHER_LEAD_ID)),
        'This unsubscribe link is not valid.',
      );
    });

    it('never leaks the email address in the state response', async () => {
      const service = deps(worldWithLead());
      const state = await service.getState(tokenFor(LEAD_ID));
      expect(JSON.stringify(state)).not.toContain('sam@example.com');
    });
  });

  describe('unsubscribe', () => {
    it('records the opt-out timestamp on first click', async () => {
      const world = worldWithLead();
      const service = deps(world);
      const result = await service.unsubscribe(tokenFor(LEAD_ID));
      expect(result).toEqual({
        unsubscribed: true,
        alreadyUnsubscribed: false,
        emailOptedOut: true,
        contactOptedOut: false,
      });
      expect(world.records.get(LEAD_ID)?.unsubscribedAt).toEqual(NOW);
    });

    it('is idempotent: a second click keeps the FIRST timestamp', async () => {
      const world = worldWithLead();
      const first = deps(world, { clock: () => NOW });
      await first.unsubscribe(tokenFor(LEAD_ID, SECRET, NOW));
      const later = new Date(NOW.getTime() + 3600 * 1000);
      const second = deps(world, { clock: () => later });
      const result = await second.unsubscribe(tokenFor(LEAD_ID, SECRET, NOW));
      expect(result).toEqual({
        unsubscribed: true,
        alreadyUnsubscribed: true,
        emailOptedOut: true,
        contactOptedOut: false,
      });
      expect(world.records.get(LEAD_ID)?.unsubscribedAt).toEqual(NOW);
    });

    it('AC1: a forged token cannot unsubscribe anyone (403, no state change)', async () => {
      const world = worldWithLead();
      const service = deps(world);
      await expectForbidden(
        service.unsubscribe(tokenFor(LEAD_ID, 'wrong-secret')),
        'This unsubscribe link is not valid.',
      );
      expect(world.records.get(LEAD_ID)?.unsubscribedAt).toBeNull();
    });

    it('AC2: an expired token performs no state change', async () => {
      const world = worldWithLead();
      const service = deps(world);
      const issued = new Date(NOW.getTime() - (TTL + 60) * 1000);
      await expectForbidden(
        service.unsubscribe(tokenFor(LEAD_ID, SECRET, issued)),
        'This unsubscribe link has expired. Request a fresh link from any Feasly email.',
      );
      expect(world.records.get(LEAD_ID)?.unsubscribedAt).toBeNull();
    });

    it('a token for lead A never unsubscribes lead B', async () => {
      const world: World = {
        records: new Map([
          [LEAD_ID, leadRecord(LEAD_ID)],
          [OTHER_LEAD_ID, leadRecord(OTHER_LEAD_ID)],
        ]),
        setUnsubscribedAtCalls: [],
      };
      const service = deps(world);
      await service.unsubscribe(tokenFor(LEAD_ID));
      expect(world.records.get(LEAD_ID)?.unsubscribedAt).toEqual(NOW);
      expect(world.records.get(OTHER_LEAD_ID)?.unsubscribedAt).toBeNull();
    });
  });

  describe('isUnsubscribed (email/02 nudge-timer suppression check)', () => {
    it('is false before opt-out, true after', async () => {
      const world = worldWithLead();
      const service = deps(world);
      expect(await service.isUnsubscribed(LEAD_ID)).toBe(false);
      await service.unsubscribe(tokenFor(LEAD_ID));
      expect(await service.isUnsubscribed(LEAD_ID)).toBe(true);
    });

    it('is false for an unknown lead (fail-closed toward sending nothing)', async () => {
      const service = deps(worldWithLead());
      expect(await service.isUnsubscribed(OTHER_LEAD_ID)).toBe(false);
    });
  });

  describe('buildUnsubscribeUrl', () => {
    it('builds a URL under the configured base with a verifiable token', async () => {
      const world = worldWithLead();
      const service = deps(world);
      const url = service.buildUnsubscribeUrl(LEAD_ID);
      expect(url.startsWith('https://feasly.example/unsubscribe/')).toBe(true);
      const token = decodeURIComponent(url.split('/').pop() as string);
      const state = await service.getState(token);
      expect(state).toEqual({
        valid: true,
        leadId: LEAD_ID,
        emailOptedOut: false,
        contactOptedOut: false,
        consentUpdatedAt: expect.any(String),
        alreadyUnsubscribed: false,
      });
    });
  });

  describe('savePreferences (granular consent)', () => {
    it('saves email + contact opt-outs independently', async () => {
      const world = worldWithLead();
      const service = deps(world);
      const result = await service.savePreferences(tokenFor(LEAD_ID), {
        emailOptOut: false,
        contactOptOut: true,
      });
      expect(result).toEqual({
        unsubscribed: false,
        alreadyUnsubscribed: false,
        emailOptedOut: false,
        contactOptedOut: true,
      });
      const state = await service.getState(tokenFor(LEAD_ID));
      expect(state).toMatchObject({
        valid: true,
        emailOptedOut: false,
        contactOptedOut: true,
      });
    });

    it('opting back in clears the timestamp and restores consent', async () => {
      const world = worldWithLead();
      const service = deps(world);
      await service.savePreferences(tokenFor(LEAD_ID), {
        emailOptOut: true,
        contactOptOut: true,
      });
      const result = await service.savePreferences(tokenFor(LEAD_ID), {
        emailOptOut: false,
        contactOptOut: false,
      });
      expect(result).toEqual({
        unsubscribed: false,
        // "already" is the pre-save state: the lead WAS opted out before
        // this opt-back-in save.
        alreadyUnsubscribed: true,
        emailOptedOut: false,
        contactOptedOut: false,
      });
      expect(await service.isUnsubscribed(LEAD_ID)).toBe(false);
      expect(await service.isContactOptedOut(LEAD_ID)).toBe(false);
    });

    it('a forged token cannot change anyone’s preferences (403, no state change)', async () => {
      const world = worldWithLead();
      const service = deps(world);
      await expectForbidden(
        service.savePreferences(tokenFor(LEAD_ID, 'wrong-secret'), {
          emailOptOut: true,
          contactOptOut: true,
        }),
        'This unsubscribe link is not valid.',
      );
      expect(await service.isContactOptedOut(LEAD_ID)).toBe(false);
    });
  });

  describe('isContactOptedOut', () => {
    it('is false before opt-out, true after a contact opt-out', async () => {
      const world = worldWithLead();
      const service = deps(world);
      expect(await service.isContactOptedOut(LEAD_ID)).toBe(false);
      await service.savePreferences(tokenFor(LEAD_ID), {
        emailOptOut: false,
        contactOptOut: true,
      });
      expect(await service.isContactOptedOut(LEAD_ID)).toBe(true);
      // Email-only opt-out does not flip the contact flag.
      expect(await service.isUnsubscribed(LEAD_ID)).toBe(false);
    });

    it('is false for an unknown lead', async () => {
      const service = deps(worldWithLead());
      expect(await service.isContactOptedOut(OTHER_LEAD_ID)).toBe(false);
    });
  });

  describe('fail-closed without a secret', () => {
    it('every operation names UNSUBSCRIBE_TOKEN_SECRET', async () => {
      const service = deps(worldWithLead(), { tokenSecret: undefined });
      const expected =
        'Unsubscribe is not configured: set UNSUBSCRIBE_TOKEN_SECRET ' +
        '(via a Key Vault reference in staging/production; never commit the secret).';
      expect(() => service.buildUnsubscribeUrl(LEAD_ID)).toThrow(expected);
      await expect(service.getState('x')).rejects.toThrow(expected);
      await expect(service.unsubscribe('x')).rejects.toThrow(expected);
    });
  });
});
