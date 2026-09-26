/**
 * Phase-2 wiring — partner-share endpoint tests.
 *
 * Service (deps faked at the interface boundary), route (service stubbed),
 * and contract-conformance: the response parses through the contracts
 * `PartnerShareResponse` zod schema. Semantics covered:
 * - valid request mints a FRESH partner magic link (never the owner's
 *   token), emails it via the email service, and records the audit row
 * - invalid body → 400; unknown/expired report tokens → 404
 * - until the ACS sender is provisioned the provider is the log channel,
 *   so `sent: true` means "accepted and logged" (placeholder flagged)
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '../src/middleware/errors';
import { PartnerShareResponseSchema } from '../src/openapi/schemas';
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

function fakeStores(opts?: { live?: boolean }) {
  const live = opts?.live ?? true;
  const persisted: NewPartnerShare[] = [];
  const sentEmails: { to: string; shareUrl: string }[] = [];
  const magicLinks = {
    findByToken: async (token: string) =>
      token === OWNER_TOKEN && live
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
    findNewestEstimateIdByEmailAndAddress: async () => null,
  } as unknown as LeadStore;
  const email = {
    sendPartnerShare: async (input: { to: string; shareUrl: string }) => {
      sentEmails.push(input);
      return { accepted: true };
    },
  } as unknown as EmailService;
  const shares: PartnerShareStore = {
    insert: async (share: NewPartnerShare) => {
      persisted.push(share);
      return {
        ...share,
        createdAt: new Date('2026-09-26T05:00:00Z'),
      } as PartnerShareRecord;
    },
    listByLeadId: async () => [],
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
});

describe('share route', () => {
  it('delegates to the share service', async () => {
    const { service } = fakeStores();
    const route = createShareRoute({ shares: service });
    const result = await route.handle(VALID_BODY);
    expect(result).toEqual({ sent: true, sharedTo: 'partner@example.com' });
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
});
