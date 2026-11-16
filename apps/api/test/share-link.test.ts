/**
 * Link-only report shares (#838, AC3).
 *
 * Runs the share service against PGlite with the real stores (magic links,
 * leads, partner shares, link shares) and a fixed, manually advanced clock.
 * Covers: a copy link is a fresh read-only partner token (never the owner
 * token) that opens the report, expires after SHARE_LINK_TTL_SECONDS, can
 * be revoked by the owner (and then stops opening the report), the
 * active-link cap, and owner-only access to all three operations.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { estimates, leads, magicLinks, partnerShares } from '../src/db/schema';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import {
  createDrizzleMagicLinkStore,
  OWNER_LINK_PURPOSE,
  type MagicLinkStore,
} from '../src/services/magic-link.store';
import { createDrizzlePartnerShareStore } from '../src/services/partner-share.store';
import { createDrizzleShareLinkStore } from '../src/services/share-link.store';
import { createShareService, type ShareService } from '../src/services/share.service';
import { resolveReportToken } from '../src/services/report-context';
import type { EmailService } from '../src/services/email';
import { createTestDb, type TestDb } from './pglite-db';

const T0 = new Date('2026-11-16T12:00:00.000Z');
const TTL_SECONDS = 3 * 24 * 3600;
const MAX_ACTIVE = 2;

async function expectHttp(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e as { status?: number },
  );
  expect(error.status).toBe(status);
}

describe('link-only report shares (PGlite, fixed clock)', () => {
  let testDb: TestDb;
  let magicLinkStore: MagicLinkStore;
  let service: ShareService;
  let now: Date;
  const clock = (): Date => now;
  let leadId: string;
  let ownerToken: string;

  async function seedLeadWithOwnerToken(): Promise<{ leadId: string; ownerToken: string }> {
    const id = randomUUID();
    const estimateId = randomUUID();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: `calgary-${id}`,
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    await testDb.db.insert(leads).values({
      id,
      estimateId,
      addressKey: `calgary-${id}`,
      email: `owner-${id}@example.com`,
      name: 'Ava Homeowner',
      timeline: '6-12 months',
      consentTs: T0,
    });
    const issued = await magicLinkStore.issue({
      leadId: id,
      purpose: OWNER_LINK_PURPOSE,
      ttlSeconds: 30 * 24 * 3600,
      clock,
    });
    return { leadId: id, ownerToken: issued.token };
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    magicLinkStore = createDrizzleMagicLinkStore({ db: testDb.db });
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    now = T0;
    await testDb.db.delete(partnerShares);
    await testDb.db.delete(magicLinks);
    service = createShareService({
      magicLinks: magicLinkStore,
      leads: createDrizzleLeadStore({ db: testDb.db }),
      shares: createDrizzlePartnerShareStore({ db: testDb.db }),
      email: {} as EmailService,
      appBaseUrl: 'https://feasly.example',
      magicLinkTtlSeconds: 7 * 24 * 3600,
      clock,
      shareLinks: createDrizzleShareLinkStore({ db: testDb.db }),
      shareLinkTtlSeconds: TTL_SECONDS,
      shareLinkMaxActive: MAX_ACTIVE,
    });
    ({ leadId, ownerToken } = await seedLeadWithOwnerToken());
  });

  function tokenOf(url: string): string {
    return url.split('/r/')[1]!;
  }

  it('creates a fresh read-only link (never the owner token) with the configured expiry', async () => {
    const link = await service.createShareLink({ reportToken: ownerToken });
    expect(link.url).toMatch(/^https:\/\/feasly\.example\/r\/.+/);
    expect(tokenOf(link.url)).not.toBe(ownerToken);
    expect(link.url).not.toContain(ownerToken);
    expect(link.expiresAt).toBe(new Date(T0.getTime() + TTL_SECONDS * 1000).toISOString());

    // It verifies as a partner link (no recipient) and reads the report…
    const verified = await service.verifyPartnerLink(tokenOf(link.url));
    expect(verified).toMatchObject({ valid: true, reportToken: tokenOf(link.url) });
    expect(verified).not.toHaveProperty('partnerEmail');
    const ctx = await resolveReportToken(
      { magicLinks: magicLinkStore, leads: createDrizzleLeadStore({ db: testDb.db }), clock },
      tokenOf(link.url),
    );
    expect(ctx.lead.id).toBe(leadId);
    expect(ctx.linkPurpose).toBe('partner-share');

    // …but is read-only: it cannot mint further links.
    await expectHttp(service.createShareLink({ reportToken: tokenOf(link.url) }), 403);
  });

  it('AC3: the link expires after SHARE_LINK_TTL_SECONDS', async () => {
    const link = await service.createShareLink({ reportToken: ownerToken });
    now = new Date(T0.getTime() + TTL_SECONDS * 1000 - 1);
    expect((await service.verifyPartnerLink(tokenOf(link.url))).valid).toBe(true);
    now = new Date(T0.getTime() + TTL_SECONDS * 1000);
    expect(await service.verifyPartnerLink(tokenOf(link.url))).toEqual({
      valid: false,
      reason: 'expired',
    });
    const list = await service.listShareLinks({ reportToken: ownerToken });
    expect(list.links.map((l) => l.status)).toEqual(['expired']);
  });

  it('AC3: the owner can revoke a link and it stops opening the report', async () => {
    const link = await service.createShareLink({ reportToken: ownerToken });
    expect(await service.revokeShareLink({ reportToken: ownerToken, shareId: link.id })).toEqual({
      id: link.id,
      status: 'revoked',
    });
    expect((await service.verifyPartnerLink(tokenOf(link.url))).valid).toBe(false);
    await expect(
      resolveReportToken(
        { magicLinks: magicLinkStore, leads: createDrizzleLeadStore({ db: testDb.db }), clock },
        tokenOf(link.url),
      ),
    ).rejects.toMatchObject({ status: 404 });
    // Idempotent.
    expect(
      (await service.revokeShareLink({ reportToken: ownerToken, shareId: link.id })).status,
    ).toBe('revoked');
    const list = await service.listShareLinks({ reportToken: ownerToken });
    expect(list.links).toEqual([
      expect.objectContaining({ id: link.id, status: 'revoked' }),
    ]);
    // The owner's own link is untouched.
    expect((await magicLinkStore.findByToken(ownerToken))?.revokedAt).toBeNull();
  });

  it('lists the owner\'s links with status and never returns a URL or token', async () => {
    const a = await service.createShareLink({ reportToken: ownerToken });
    const b = await service.createShareLink({ reportToken: ownerToken });
    await service.revokeShareLink({ reportToken: ownerToken, shareId: a.id });
    const list = await service.listShareLinks({ reportToken: ownerToken });
    expect(new Map(list.links.map((l) => [l.id, l.status]))).toEqual(
      new Map([
        [a.id, 'revoked'],
        [b.id, 'active'],
      ]),
    );
    const json = JSON.stringify(list);
    expect(json).not.toContain(tokenOf(a.url));
    expect(json).not.toContain(tokenOf(b.url));
  });

  it('caps live links per report; revoking one frees a slot', async () => {
    const first = await service.createShareLink({ reportToken: ownerToken });
    await service.createShareLink({ reportToken: ownerToken });
    await expectHttp(service.createShareLink({ reportToken: ownerToken }), 429);
    await service.revokeShareLink({ reportToken: ownerToken, shareId: first.id });
    await expect(service.createShareLink({ reportToken: ownerToken })).resolves.toBeDefined();
  });

  it('another owner cannot revoke or see someone else\'s link (404, no oracle)', async () => {
    const link = await service.createShareLink({ reportToken: ownerToken });
    const other = await seedLeadWithOwnerToken();
    await expectHttp(
      service.revokeShareLink({ reportToken: other.ownerToken, shareId: link.id }),
      404,
    );
    expect((await service.listShareLinks({ reportToken: other.ownerToken })).links).toEqual([]);
    expect((await service.verifyPartnerLink(tokenOf(link.url))).valid).toBe(true);
  });

  it('partner tokens cannot list or revoke (owner-only, 403)', async () => {
    const link = await service.createShareLink({ reportToken: ownerToken });
    const partner = tokenOf(link.url);
    await expectHttp(service.listShareLinks({ reportToken: partner }), 403);
    await expectHttp(service.revokeShareLink({ reportToken: partner, shareId: link.id }), 403);
  });

  it('unknown tokens 404; malformed bodies 400', async () => {
    await expectHttp(service.createShareLink({ reportToken: 'nope' }), 404);
    await expectHttp(service.createShareLink({}), 400);
    await expectHttp(service.createShareLink({ reportToken: ownerToken, extra: 1 }), 400);
    await expectHttp(service.revokeShareLink({ reportToken: ownerToken, shareId: 'not-a-uuid' }), 400);
  });

  it('link shares do not count toward the emailed-share daily cap', async () => {
    const shares = createDrizzlePartnerShareStore({ db: testDb.db });
    await service.createShareLink({ reportToken: ownerToken });
    expect(await shares.countSince(leadId, new Date(0))).toBe(0);
  });
});
