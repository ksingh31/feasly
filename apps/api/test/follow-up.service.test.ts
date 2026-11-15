/**
 * Post-report follow-up service (#703, AC3).
 *
 * The follow-up is sent at most once per lead, never without marketing
 * consent, never after unsubscribe / contact opt-out / erasure, and not at
 * all with the flag off. Same no-retry + accepted-but-unconfirmed rules as
 * the 24h nudge. Stores, email and unsubscribe are faked at the interface.
 */
import { describe, expect, it } from 'vitest';
import { createFollowUpService } from '../src/services/follow-up.service';
import type { FollowUpEmailInput, EmailDelivery } from '../src/services/email/email.service';
import type { LeadFollowUpStore } from '../src/services/lead-follow-up.store';
import type { LeadRecord } from '../src/services/lead.store';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-15T12:00:00Z');
const DELAY_HOURS = 72;
const OK: EmailDelivery = { sent: true, provider: 'log' };

function leadFixture(overrides?: Partial<LeadRecord>): LeadRecord {
  return {
    id: 'lead-1',
    estimateId: 'est-1',
    addressKey: '1412 PROSPECT AV SW',
    email: 'sam@example.com',
    name: 'Sam',
    phone: null,
    timeline: '3-6 months',
    marketingConsent: true,
    consentTs: NOW,
    tenantKey: null,
    source: 'web',
    quarantined: false,
    sandbox: false,
    leadScore: 50,
    status: 'new',
    builderId: null,
    unsubscribedAt: null,
    contactOptOutAt: null,
    consentUpdatedAt: NOW,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: NOW,
    createdAt: new Date(NOW.getTime() - 100 * HOUR),
    ...overrides,
  };
}

interface Row {
  lead: LeadRecord;
  reportOpenedAt: Date | null;
  followUpSentAt: Date | null;
}

function world(opts?: {
  enabled?: boolean;
  rows?: Row[];
  delivery?: EmailDelivery;
  unsubscribed?: string[];
  contactOptedOut?: string[];
  unsubscribeSecretMissing?: boolean;
  sendThrows?: boolean;
  /** Ids returned by findCandidates regardless of the SQL filter (races). */
  staleCandidates?: string[];
}) {
  const rows = new Map<string, Row>((opts?.rows ?? []).map((r) => [r.lead.id, r]));
  const sent: FollowUpEmailInput[] = [];
  const errors: unknown[] = [];
  const warnings: string[] = [];
  let issued = 0;

  // Mirrors the Drizzle query filter (SQL-level eligibility).
  const followUps: LeadFollowUpStore = {
    markReportOpened: async ({ leadId, at }) => {
      const r = rows.get(leadId);
      if (r && r.reportOpenedAt === null) r.reportOpenedAt = at;
    },
    findCandidates: async ({ openedAfter, openedBefore, limit }) =>
      (opts?.staleCandidates ?? []).concat(
      [...rows.values()]
        .filter(
          (r) =>
            r.reportOpenedAt !== null &&
            r.reportOpenedAt >= openedAfter &&
            r.reportOpenedAt < openedBefore &&
            r.followUpSentAt === null &&
            r.lead.marketingConsent &&
            r.lead.unsubscribedAt === null &&
            r.lead.contactOptOutAt === null &&
            !r.lead.quarantined &&
            !r.lead.sandbox,
        )
        .slice(0, limit)
        .map((r) => r.lead.id)),
    findState: async (leadId) => {
      const r = rows.get(leadId);
      return r ? { reportOpenedAt: r.reportOpenedAt, followUpSentAt: r.followUpSentAt } : null;
    },
    setFollowUpSentAt: async ({ leadId, at }) => {
      const r = rows.get(leadId);
      if (r) r.followUpSentAt = at;
    },
  };

  const service = createFollowUpService({
    enabled: opts?.enabled ?? true,
    leads: { findById: async (id) => rows.get(id)?.lead ?? null },
    followUps,
    magicLinks: {
      issue: async () => {
        issued++;
        return {
          id: `link-${issued}`,
          token: `fresh-${issued}`,
          expiresAt: new Date(NOW.getTime() + 7 * 24 * HOUR),
        };
      },
    },
    email: {
      sendFollowUp: async (input) => {
        if (opts?.sendThrows) throw new Error('smtp down');
        sent.push(input);
        return opts?.delivery ?? OK;
      },
    },
    unsubscribe: {
      isUnsubscribed: async (id) => (opts?.unsubscribed ?? []).includes(id),
      isContactOptedOut: async (id) => (opts?.contactOptedOut ?? []).includes(id),
      buildUnsubscribeUrl: (id) => {
        if (opts?.unsubscribeSecretMissing) throw new Error('no secret');
        return `https://feasly.example/unsubscribe/${id}.sig`;
      },
    },
    appBaseUrl: 'https://feasly.example',
    magicLinkTtlSeconds: 604_800,
    delayHours: DELAY_HOURS,
    onLeadError: (e) => errors.push(e),
    onWarn: (m) => warnings.push(m),
    clock: () => NOW,
  });
  return { service, rows, sent, errors, warnings, get issued() { return issued; } };
}

/** Opened 72.5h before NOW — inside the [73h, 72h) window. */
const DUE = new Date(NOW.getTime() - (DELAY_HOURS + 0.5) * HOUR);

function dueRow(overrides?: Partial<LeadRecord>, row?: Partial<Row>): Row {
  return { lead: leadFixture(overrides), reportOpenedAt: DUE, followUpSentAt: null, ...row };
}

describe('follow-up service (#703)', () => {
  it('sends one follow-up to a consenting lead whose report was opened ~delay ago', async () => {
    const w = world({ rows: [dueRow()] });
    const result = await w.service.runFollowUpCycle();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      to: 'sam@example.com',
      name: 'Sam',
      address: '1412 Prospect Av SW',
      reportUrl: 'https://feasly.example/r/fresh-1',
      unsubscribeUrl: 'https://feasly.example/unsubscribe/lead-1.sig',
    });
    expect(w.rows.get('lead-1')!.followUpSentAt).toEqual(NOW);
  });

  it('AC3: at most once per lead — a second cycle (even with the window reset) sends nothing', async () => {
    const w = world({ rows: [dueRow()] });
    await w.service.runFollowUpCycle();
    await w.service.runFollowUpCycle();
    expect(w.sent).toHaveLength(1);
  });

  it('AC3: already-stamped leads are skipped even if a stale candidate list returns them', async () => {
    // A concurrent timer listed the lead before another instance stamped it.
    const w = world({
      rows: [dueRow({}, { followUpSentAt: new Date(NOW.getTime() - HOUR) })],
      staleCandidates: ['lead-1'],
    });
    const result = await w.service.runFollowUpCycle();
    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(w.sent).toHaveLength(0);
  });

  it('AC3: never without marketing consent', async () => {
    const w = world({ rows: [dueRow({ marketingConsent: false })] });
    await w.service.runFollowUpCycle();
    expect(w.sent).toHaveLength(0);
  });

  it('AC3: never after unsubscribe (row flag or unsubscribe service)', async () => {
    const a = world({ rows: [dueRow({ unsubscribedAt: new Date(NOW.getTime() - HOUR) })] });
    await a.service.runFollowUpCycle();
    expect(a.sent).toHaveLength(0);

    const b = world({ rows: [dueRow()], unsubscribed: ['lead-1'] });
    await b.service.runFollowUpCycle();
    expect(b.sent).toHaveLength(0);
    expect(b.rows.get('lead-1')!.followUpSentAt).toBeNull();
  });

  it('never after a calls/messages contact opt-out', async () => {
    const w = world({ rows: [dueRow()], contactOptedOut: ['lead-1'] });
    await w.service.runFollowUpCycle();
    expect(w.sent).toHaveLength(0);
  });

  it('AC3: never after erasure (no lead row → no candidate, no send)', async () => {
    const w = world({ rows: [dueRow()] });
    w.rows.delete('lead-1');
    const result = await w.service.runFollowUpCycle();
    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(w.sent).toHaveLength(0);
  });

  it('AC3: not at all with the flag off — no reads, no sends', async () => {
    const w = world({ enabled: false, rows: [dueRow()] });
    const result = await w.service.runFollowUpCycle();
    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(w.sent).toHaveLength(0);
    expect(w.issued).toBe(0);
  });

  it('skips quarantined and sandbox leads', async () => {
    const w = world({
      rows: [dueRow({ id: 'q', quarantined: true }), dueRow({ id: 's', sandbox: true })],
    });
    await w.service.runFollowUpCycle();
    expect(w.sent).toHaveLength(0);
  });

  it('only leads opened inside the [delay+1h, delay) window are due', async () => {
    const w = world({
      rows: [
        dueRow({ id: 'too-new' }, { reportOpenedAt: new Date(NOW.getTime() - 10 * HOUR) }),
        dueRow({ id: 'too-old' }, { reportOpenedAt: new Date(NOW.getTime() - 80 * HOUR) }),
        dueRow({ id: 'never-opened' }, { reportOpenedAt: null }),
      ],
    });
    await w.service.runFollowUpCycle();
    expect(w.sent).toHaveLength(0);
  });

  it('missing unsubscribe secret fails safe: no send, no stamp (CASL)', async () => {
    const w = world({ rows: [dueRow()], unsubscribeSecretMissing: true });
    await w.service.runFollowUpCycle();
    expect(w.sent).toHaveLength(0);
    expect(w.rows.get('lead-1')!.followUpSentAt).toBeNull();
  });

  it('a failed send is counted as skipped, not stamped, and reported to the sink', async () => {
    const w = world({
      rows: [dueRow()],
      delivery: { sent: false, provider: 'log', failureReason: 'down', emailError: 'delivery-failed' },
    });
    const result = await w.service.runFollowUpCycle();
    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(w.rows.get('lead-1')!.followUpSentAt).toBeNull();
    expect(w.errors).toHaveLength(1);
  });

  it('one throwing lead does not kill the batch', async () => {
    const w = world({ rows: [dueRow({ id: 'a' }), dueRow({ id: 'b' })], sendThrows: true });
    const result = await w.service.runFollowUpCycle();
    expect(result).toEqual({ sent: 0, skipped: 2 });
    expect(w.errors).toHaveLength(2);
  });

  it('accepted-but-unconfirmed counts as sent and is stamped (no duplicate marketing mail)', async () => {
    const w = world({
      rows: [dueRow()],
      delivery: {
        sent: false,
        provider: 'acs',
        failureReason: 'poll timeout',
        emailError: 'delivery-failed',
        acceptedByProvider: true,
      },
    });
    const result = await w.service.runFollowUpCycle();
    expect(result.sent).toBe(1);
    expect(w.rows.get('lead-1')!.followUpSentAt).toEqual(NOW);
    expect(w.warnings[0]).toContain('delivery unconfirmed');
    expect(w.warnings[0]).not.toContain('sam@example.com');
  });
});
