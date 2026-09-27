/**
 * Phase-2 wiring — partner-share endpoint tests.
 *
 * Service (deps faked at the interface boundary), route (service stubbed),
 * and contract-conformance: the response parses through the contracts
 * `PartnerShareResponse` / `PartnerShareVerifyResponse` zod schemas.
 * Semantics covered:
 * - valid request mints a FRESH partner magic link (never the owner's
 *   token), emails it via the email service, and records the audit row
 * - invalid body → 400; unknown/expired report tokens → 404
 * - partner tokens are a DIFFERENT token type: the owner magic-link verify
 *   answers them invalid, and only the dedicated GET /v1/shares/verify
 *   path redeems them (success → reportToken + newest estimateId +
 *   partnerEmail; expired → expired; unknown/never-emailed → invalid)
 * - owner-only actions (share, revisions, callback) reject partner tokens
 *   with 403
 * - until the ACS sender is provisioned the provider is the log channel,
 *   so `sent: true` means "accepted and logged" (placeholder flagged)
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '../src/middleware/errors';
import {
  PartnerShareResponseSchema,
  PartnerShareVerifyResponseSchema,
} from '../src/openapi/schemas';
import { createShareRoute } from '../src/routes/share.route';
import { createShareService, type ShareService } from '../src/services/share.service';
import type { EmailService } from '../src/services/email/email.service';
import type { LeadStore } from '../src/services/lead.store';
import type {
  IssuedMagicLink,
  MagicLinkStore,
} from '../src/services/magic-link.store';
import type {
  NewPartnerShare,
  PartnerShareRecord,
  PartnerShareStore,
} from '../src/services/partner-share.store';

const LEAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_TOKEN = 'raw-owner-report-token';
const PARTNER_TOKEN = 'raw-partner-token';
const PARTNER_LINK_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';
const OWNER_LINK_ID = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';

function fakeStores(opts?: {
  live?: boolean;
  partnerLive?: boolean;
  partnerExpired?: boolean;
  emailed?: boolean;
  newestEstimateId?: string | null;
  insertFails?: boolean;
}) {
  const live = opts?.live ?? true;
  const partnerLive = opts?.partnerLive ?? true;
  const partnerExpired = opts?.partnerExpired ?? false;
  const emailed = opts?.emailed ?? true;
  const newestEstimateId = opts?.newestEstimateId;
  const persisted: NewPartnerShare[] = [];
  const sentEmails: { to: string; shareUrl: string; expiresInDays?: number }[] = [];
  const magicLinks = {
    findByToken: async (token: string) => {
      if (token === OWNER_TOKEN && live) {
        return {
          id: OWNER_LINK_ID,
          leadId: LEAD_ID,
          purpose: 'lead',
          tokenHash: 'hash',
          email: null,
          expiresAt: new Date('2026-10-03T00:00:00Z'),
          usedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-09-26T04:00:00Z'),
        };
      }
      if (token === PARTNER_TOKEN && partnerLive) {
        return {
          id: PARTNER_LINK_ID,
          leadId: LEAD_ID,
          purpose: 'partner-share',
          tokenHash: 'hash',
          email: null,
          expiresAt: partnerExpired
            ? new Date('2026-09-01T00:00:00Z')
            : new Date('2026-10-03T00:00:00Z'),
          usedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-09-26T04:00:00Z'),
        };
      }
      return null;
    },
    issue: async (): Promise<IssuedMagicLink> => ({
      id: PARTNER_LINK_ID,
      token: PARTNER_TOKEN,
      expiresAt: new Date('2026-10-03T00:00:00Z'),
    }),
  } as unknown as MagicLinkStore;
  const leads = {
    findById: async (id: string) =>
      id === LEAD_ID
        ? {
            id: LEAD_ID,
            estimateId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            addressKey: 'calgary:123-elm-st',
            email: 'homeowner@example.com',
            name: 'Home Owner',
          }
        : null,
    findNewestEstimateIdByEmailAndAddress: async () =>
      newestEstimateId === undefined || newestEstimateId === null
        ? null
        : { estimateId: newestEstimateId },
  } as unknown as LeadStore;
  const email = {
    sendPartnerShare: async (input: { to: string; shareUrl: string }) => {
      sentEmails.push(input);
      return { accepted: true };
    },
  } as unknown as EmailService;
  const auditRow: PartnerShareRecord = {
    id: 'ssssssss-ssss-4sss-8sss-ssssssssssss',
    leadId: LEAD_ID,
    magicLinkId: PARTNER_LINK_ID,
    partnerEmail: 'partner@example.com',
    sent: true,
    createdAt: new Date('2026-09-26T05:00:00Z'),
  };
  const shares: PartnerShareStore = {
    insert: async (share: NewPartnerShare) => {
      if (opts?.insertFails === true) {
        throw new Error('partner_shares insert failed');
      }
      persisted.push(share);
      return {
        ...share,
        createdAt: new Date('2026-09-26T05:00:00Z'),
      } as PartnerShareRecord;
    },
    listByLeadId: async () => [],
    findByMagicLinkId: async (magicLinkId: string) =>
      emailed && magicLinkId === PARTNER_LINK_ID ? auditRow : null,
  };
  const service: ShareService = createShareService({
    magicLinks,
    leads,
    shares,
    email,
    appBaseUrl: 'https://feasly.example.com',
    magicLinkTtlSeconds: 604800,
    clock: () => new Date('2026-09-26T05:00:00Z'),
  });
  return { service, persisted, sentEmails };
}

const VALID_BODY = { reportToken: OWNER_TOKEN, partnerEmail: 'partner@example.com' };

describe('share service', () => {
  it('mints a fresh partner link, emails it, and records the audit row', async () => {
    const { service, persisted, sentEmails } = fakeStores();
    const result = await service.shareWithPartner(VALID_BODY);
    expect(result).toEqual({ sent: true, sharedTo: 'partner@example.com' });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe('partner@example.com');
    expect(sentEmails[0]?.shareUrl).toContain(PARTNER_TOKEN);
    // The owner's token never goes into the partner's email.
    expect(sentEmails[0]?.shareUrl).not.toContain(OWNER_TOKEN);
    // Expiry rendered from the share-token TTL config (604800s = 7 days), never hardcoded.
    expect(sentEmails[0]?.expiresInDays).toBe(7);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      leadId: LEAD_ID,
      magicLinkId: PARTNER_LINK_ID,
      partnerEmail: 'partner@example.com',
      sent: true,
    });
    expect(JSON.stringify(persisted[0])).not.toContain(OWNER_TOKEN);
  });

  it('normalizes the partner email', async () => {
    const { service, sentEmails } = fakeStores();
    await service.shareWithPartner({
      ...VALID_BODY,
      partnerEmail: '  Partner@Example.COM  ',
    });
    expect(sentEmails[0]?.to).toBe('partner@example.com');
  });

  it('rejects invalid bodies', async () => {
    const { service, persisted, sentEmails } = fakeStores();
    for (const body of [
      {},
      { ...VALID_BODY, partnerEmail: 'not-an-email' },
      { ...VALID_BODY, reportToken: '' },
    ]) {
      await expect(service.shareWithPartner(body)).rejects.toMatchObject({
        status: 400,
        code: ErrorCodes.VALIDATION_FAILED,
      });
    }
    expect(persisted).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it('answers 404 for unknown report tokens', async () => {
    const { service } = fakeStores({ live: false });
    await expect(service.shareWithPartner(VALID_BODY)).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it('rejects a partner token with 403 — only the owner link mints shares', async () => {
    const { service, sentEmails, persisted } = fakeStores();
    await expect(
      service.shareWithPartner({
        reportToken: PARTNER_TOKEN,
        partnerEmail: 'someone@example.com',
      }),
    ).rejects.toMatchObject({ status: 403, code: ErrorCodes.FORBIDDEN });
    expect(sentEmails).toHaveLength(0);
    expect(persisted).toHaveLength(0);
  });
});

describe('partner-share verify', () => {
  it('redeems a live partner link to its report + recipient', async () => {
    const { service } = fakeStores();
    const result = await service.verifyPartnerLink(PARTNER_TOKEN);
    expect(result).toEqual({
      valid: true,
      reportToken: PARTNER_TOKEN,
      estimateId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      partnerEmail: 'partner@example.com',
    });
    // The partner's own token is the report handle — never the owner token.
    expect(JSON.stringify(result)).not.toContain(OWNER_TOKEN);
  });

  it('resolves an old partner link to the NEWEST estimate (consumer/02 semantics)', async () => {
    const { service } = fakeStores({
      newestEstimateId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    const result = await service.verifyPartnerLink(PARTNER_TOKEN);
    expect(result).toEqual({
      valid: true,
      reportToken: PARTNER_TOKEN,
      estimateId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      partnerEmail: 'partner@example.com',
    });
  });

  it('answers invalid for unknown tokens', async () => {
    const { service } = fakeStores();
    expect(await service.verifyPartnerLink('nope')).toEqual({
      valid: false,
      reason: 'invalid',
    });
    expect(await service.verifyPartnerLink('')).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('answers invalid for the OWNER token — a different token type', async () => {
    const { service } = fakeStores();
    // The owner token verifies on /v1/magic-link/verify, never here.
    expect(await service.verifyPartnerLink(OWNER_TOKEN)).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('answers expired for a revoked/expired partner link', async () => {
    const { service } = fakeStores({ partnerExpired: true });
    expect(await service.verifyPartnerLink(PARTNER_TOKEN)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('answers invalid for a link that was minted but never emailed', async () => {
    const { service } = fakeStores({ emailed: false });
    // No audit row: the provider never accepted the email, so the link is dead.
    expect(await service.verifyPartnerLink(PARTNER_TOKEN)).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('an audit-row insert failure after the email send propagates (never swallowed)', async () => {
    const { service, sentEmails } = fakeStores({ insertFails: true });
    // The email went out, but the audit row write died: the failure must
    // surface to the caller (route → 500 → owner retries with a fresh
    // link) rather than answer { sent: true } with an unrecorded share.
    await expect(service.shareWithPartner(VALID_BODY)).rejects.toThrow(
      'partner_shares insert failed',
    );
    expect(sentEmails).toHaveLength(1);
  });
});

describe('share route', () => {
  it('delegates to the share service', async () => {
    const { service } = fakeStores();
    const route = createShareRoute({ shares: service });
    const result = await route.handle(VALID_BODY);
    expect(result).toEqual({ sent: true, sharedTo: 'partner@example.com' });
  });

  it('verify delegates to the service and rejects empty query tokens', async () => {
    const { service } = fakeStores();
    const route = createShareRoute({ shares: service });
    expect(await route.verify({ token: PARTNER_TOKEN })).toEqual({
      valid: true,
      reportToken: PARTNER_TOKEN,
      estimateId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      partnerEmail: 'partner@example.com',
    });
    expect(await route.verify({})).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });
});

describe('share contract conformance', () => {
  it('the route response validates against the contracts PartnerShareResponse schema', async () => {
    const { service } = fakeStores();
    const route = createShareRoute({ shares: service });
    const result = await route.handle(VALID_BODY);
    expect(
      PartnerShareResponseSchema.safeParse(JSON.parse(JSON.stringify(result))).success,
    ).toBe(true);
  });

  it('the verify response validates against the contracts PartnerShareVerifyResponse schema', async () => {
    const { service } = fakeStores();
    const route = createShareRoute({ shares: service });
    for (const result of [
      await route.verify({ token: PARTNER_TOKEN }),
      await route.verify({ token: 'unknown' }),
    ]) {
      expect(
        PartnerShareVerifyResponseSchema.safeParse(
          JSON.parse(JSON.stringify(result)),
        ).success,
      ).toBe(true);
    }
  });
});
