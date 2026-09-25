/**
 * Nudge service tests (email/02).
 *
 * Time-mocked: the clock is fixed, leads are placed at precise ages, and
 * the timer window is narrowed so each test is deterministic.
 *
 * Acceptance criteria covered:
 *  1. 24h-old lead, link unclicked → exactly one nudge; nudge_sent_at set.
 *  2. Second run → no second nudge (guard).
 *  3. Verified lead (link used) → no nudge.
 *  4. Opted-out lead → no nudge (unsubscribe honored).
 *  5. Nudge carries the fresh magic link + one-click unsubscribe URL;
 *     no PII beyond the recipient's own email.
 */
import { describe, expect, it } from 'vitest';
import { createNudgeService } from '../src/services/nudge.service';
import type { LeadRecord, LeadStore } from '../src/services/lead.store';
import type {
  IssuedMagicLink,
  MagicLinkRecord,
  MagicLinkStore,
} from '../src/services/magic-link.store';
import type {
  EmailService,
  NudgeEmailInput,
} from '../src/services/email/email.service';
import type { EmailSendResult } from '../src/services/email/email.types';
import type { UnsubscribeService } from '../src/services/unsubscribe.service';

const NOW = new Date('2026-09-25T12:00:00Z');
const HOUR = 3_600_000;

function leadFixture(overrides?: Partial<LeadRecord>): LeadRecord {
  return {
    id: 'lead-1',
    estimateId: 'est-1',
    addressKey: 'addr-1',
    email: 'sam@example.com',
    name: 'Sam',
    phone: null,
    timeline: '3-6 months',
    marketingConsent: true,
    consentTs: new Date(NOW.getTime() - 25 * HOUR),
    tenantKey: null,
    source: 'web',
    quarantined: false,
    leadScore: 50,
    status: 'new',
    unsubscribedAt: null,
    nudgeSentAt: null,
    // 24h30m old — inside the default [23h, 24h) window behind NOW.
    createdAt: new Date(NOW.getTime() - 24.5 * HOUR),
    ...overrides,
  };
}

function linkRecord(overrides?: Partial<MagicLinkRecord>): MagicLinkRecord {
  return {
    id: 'link-1',
    leadId: 'lead-1',
    purpose: 'lead',
    tokenHash: 'hash-1',
    expiresAt: new Date(NOW.getTime() + HOUR),
    usedAt: null,
    revokedAt: null,
    createdAt: new Date(NOW.getTime() - 24 * HOUR),
    ...overrides,
  };
}

interface World {
  leads: Map<string, LeadRecord>;
  links: MagicLinkRecord[];
  nudges: NudgeEmailInput[];
  revoked: string[];
  issued: number;
  nudgeSentAtCalls: Array<{ id: string; at: Date }>;
  unsubscribed: Set<string>;
}

function makeWorld(): World {
  return {
    leads: new Map(),
    links: [],
    nudges: [],
    revoked: [],
    issued: 0,
    nudgeSentAtCalls: [],
    unsubscribed: new Set(),
  };
}

const OK: EmailSendResult = { provider: 'log', messageId: 'msg-1' };

function makeService(world: World, opts?: { failNudgeFor?: string }) {
  const leads: LeadStore = {
    findRecentByEmailAndAddress: async () => null,
    insert: async () => {
      throw new Error('not used');
    },
    updateOnRepeat: async () => {
      throw new Error('not used');
    },
    findNewestEstimateIdByEmailAndAddress: async () => null,
    appendNote: async () => {},
    getNotes: async () => [],
    appendStatusHistory: async () => {},
    getStatusHistory: async () => [],
    listLeads: async () => [],
    findById: async (id: string) => world.leads.get(id) ?? null,
    setUnsubscribedAt: async () => null,
    findNudgeCandidates: async (args) =>
      [...world.leads.values()].filter(
        (l) =>
          l.createdAt >= args.createdAfter &&
          l.createdAt < args.createdBefore &&
          l.nudgeSentAt === null,
      ),
    setNudgeSentAt: async (args: { id: string; at: Date }) => {
      world.nudgeSentAtCalls.push(args);
      const record = world.leads.get(args.id);
      if (!record) return null;
      const updated = { ...record, nudgeSentAt: args.at };
      world.leads.set(args.id, updated);
      return updated;
    },
    findAllByEmail: async () => [],
    deleteByEmail: async () => 0,
  };

  const magicLinks: MagicLinkStore = {
    issue: async (args): Promise<IssuedMagicLink> => {
      world.issued++;
      const token = `fresh-token-${world.issued}`;
      world.links.push(
        linkRecord({
          id: `link-new-${world.issued}`,
          leadId: args.leadId,
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + 7 * 24 * HOUR),
        }),
      );
      return {
        id: `link-new-${world.issued}`,
        token,
        expiresAt: new Date(NOW.getTime() + 7 * 24 * HOUR),
      };
    },
    findByToken: async () => null,
    findByLeadIds: async (ids) =>
      world.links.filter((l) => l.leadId && ids.includes(l.leadId)),
    revokeByLeadIds: async (ids, revokedAt) => {
      let n = 0;
      for (const l of world.links) {
        if (l.leadId && ids.includes(l.leadId) && l.revokedAt === null) {
          world.revoked.push(l.id);
          n++;
        }
      }
      void revokedAt;
      return n;
    },
  };

  const email = {
    sendNudge: async (input: NudgeEmailInput): Promise<EmailSendResult> => {
      if (opts?.failNudgeFor && input.to === opts.failNudgeFor) {
        throw new Error('smtp down');
      }
      world.nudges.push(input);
      return OK;
    },
  } as unknown as EmailService;

  const unsubscribe = {
    isUnsubscribed: async (leadId: string) => world.unsubscribed.has(leadId),
    buildUnsubscribeUrl: (leadId: string) =>
      `https://feasly.example/unsubscribe/${leadId}.token`,
  } as unknown as UnsubscribeService;

  const service = createNudgeService({
    leads,
    magicLinks,
    email,
    unsubscribe,
    appBaseUrl: 'https://feasly.example',
    magicLinkTtlSeconds: 604_800,
    clock: () => NOW,
  });
  return { service, world };
}

describe('nudge service (email/02)', () => {
  it('AC1: 24h-old lead with an unclicked link gets exactly one nudge', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    world.links.push(linkRecord());
    const { service } = makeService(world);

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 1, skipped: 0 });
    expect(world.nudges).toHaveLength(1);
    expect(world.nudgeSentAtCalls).toHaveLength(1);
    expect(world.nudgeSentAtCalls[0]).toEqual({ id: 'lead-1', at: NOW });
    // The stored lead now carries the guard timestamp.
    expect(world.leads.get('lead-1')!.nudgeSentAt).toEqual(NOW);
  });

  it('AC2: a second run sends no second nudge (exactly-once guard)', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    world.links.push(linkRecord());
    const { service } = makeService(world);

    await service.runNudgeCycle();
    const second = await service.runNudgeCycle();

    expect(second).toEqual({ nudged: 0, skipped: 0 });
    expect(world.nudges).toHaveLength(1);
    expect(world.issued).toBe(1);
  });

  it('AC3: a lead that verified in the meantime gets no nudge', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    world.links.push(linkRecord({ usedAt: new Date(NOW.getTime() - HOUR) }));
    const { service } = makeService(world);

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 0, skipped: 1 });
    expect(world.nudges).toHaveLength(0);
    expect(world.issued).toBe(0);
    // Not stamped — the lead ages out of the 24h window on its own.
    expect(world.nudgeSentAtCalls).toHaveLength(0);
  });

  it('AC4: an opted-out lead gets no nudge (unsubscribe honored)', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    world.links.push(linkRecord());
    world.unsubscribed.add('lead-1');
    const { service } = makeService(world);

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 0, skipped: 1 });
    expect(world.nudges).toHaveLength(0);
    expect(world.issued).toBe(0);
  });

  it('quarantined leads get no nudge', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture({ quarantined: true }));
    world.links.push(linkRecord());
    const { service } = makeService(world);

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 0, skipped: 1 });
    expect(world.nudges).toHaveLength(0);
  });

  it('AC5: the nudge carries the fresh link and the one-click unsubscribe URL', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    world.links.push(linkRecord());
    const { service } = makeService(world);

    await service.runNudgeCycle();

    const nudge = world.nudges[0]!;
    // Fresh link (not the old unclicked one), path-based like the app.
    expect(nudge.resumeUrl).toBe('https://feasly.example/r/fresh-token-1');
    // One-click unsubscribe URL from email/03's service.
    expect(nudge.unsubscribeUrl).toBe(
      'https://feasly.example/unsubscribe/lead-1.token',
    );
    // Recipient addressing only — no PII beyond the lead's own email.
    expect(nudge.to).toBe('sam@example.com');
    expect(nudge.name).toBe('Sam');
  });

  it('the old unclicked link is revoked when the fresh one is issued', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    world.links.push(linkRecord({ id: 'link-old' }));
    const { service } = makeService(world);

    await service.runNudgeCycle();

    expect(world.revoked).toContain('link-old');
    expect(world.issued).toBe(1);
  });

  it('leads younger than 24h are not nudged yet', async () => {
    const world = makeWorld();
    world.leads.set(
      'lead-1',
      leadFixture({ createdAt: new Date(NOW.getTime() - 12 * HOUR) }),
    );
    world.links.push(linkRecord());
    const { service } = makeService(world);

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 0, skipped: 0 });
    expect(world.nudges).toHaveLength(0);
  });

  it('leads older than the window are not nudged (they had their chance)', async () => {
    const world = makeWorld();
    world.leads.set(
      'lead-1',
      leadFixture({ createdAt: new Date(NOW.getTime() - 48 * HOUR) }),
    );
    world.links.push(linkRecord());
    const { service } = makeService(world);

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 0, skipped: 0 });
    expect(world.nudges).toHaveLength(0);
  });

  it('a lead with no link at all still gets a nudge (fresh link issued)', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    const { service } = makeService(world);

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 1, skipped: 0 });
    expect(world.issued).toBe(1);
  });

  it('one bad lead does not kill the batch', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture({ id: 'lead-1' }));
    world.leads.set('lead-2', leadFixture({ id: 'lead-2', email: 'x@y.z' }));
    world.links.push(linkRecord({ leadId: 'lead-1' }));
    world.links.push(linkRecord({ id: 'link-2', leadId: 'lead-2' }));
    const { service } = makeService(world, { failNudgeFor: 'x@y.z' });

    const result = await service.runNudgeCycle();

    // lead-1 nudged; lead-2's email failure is counted as skipped and
    // does not prevent lead-1's nudge.
    expect(result).toEqual({ nudged: 1, skipped: 1 });
    expect(world.nudges).toHaveLength(1);
    expect(world.nudges[0]!.to).toBe('sam@example.com');
    // lead-2 not stamped — retried next run.
    expect(
      world.nudgeSentAtCalls.filter((c) => c.id === 'lead-2'),
    ).toHaveLength(0);
  });

  it('an email failure is counted as skipped and retried next run (no stamp)', async () => {
    const world = makeWorld();
    world.leads.set('lead-1', leadFixture());
    world.links.push(linkRecord());
    const { service } = makeService(world, {
      failNudgeFor: 'sam@example.com',
    });

    const result = await service.runNudgeCycle();

    expect(result).toEqual({ nudged: 0, skipped: 1 });
    // Not stamped — the next hourly run will retry.
    expect(world.nudgeSentAtCalls).toHaveLength(0);
  });
});
