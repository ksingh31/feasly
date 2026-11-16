/**
 * Builder notifications service (#725).
 *
 * New-lead email (send-once outbox, per-member opt-out, retry on provider
 * failure), the daily "Needs you" digest (opt-in, once per local day, never
 * for an empty feed), member preferences (last billing admin can't opt
 * out) and billing recipients. The store is an in-memory fake with the same
 * dedupe + claim-lease semantics as the Drizzle store; the clock is
 * injected.
 */
import { describe, expect, it } from 'vitest';
import type {
  BuilderLeadNeedsYouItem,
  BuilderLeadsNeedsYouResponse,
  BuilderNotificationPreferences,
} from '@feasly/contracts';
import {
  createBuilderNotificationsService,
  firstNameOf,
  localDayAndHour,
  projectTypeLabel,
  type NotificationSessionRef,
} from '../src/services/builder-notifications.service';
import {
  DEFAULT_BUILDER_NOTIFICATION_PREFERENCES,
  type BuilderNotificationRecord,
  type BuilderNotificationStore,
  type NotificationBuilder,
  type NotificationLead,
  type NotificationMember,
} from '../src/services/builder-notification.store';
import type {
  BuilderNeedsYouDigestEmailInput,
  BuilderNewLeadEmailInput,
  EmailDelivery,
} from '../src/services/email/email.service';
import { HttpError } from '../src/middleware/errors';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Tests use a fixed-offset zone (Etc/GMT+7 = UTC-7, no DST) so they never
// depend on the machine's tzdata. 2026-11-16 15:00 UTC = 08:00 local.
const TZ = 'Etc/GMT+7';
const NOW = new Date('2026-11-16T15:00:00Z');
const OK: EmailDelivery = { sent: true, provider: 'log' };
const FAIL: EmailDelivery = {
  sent: false,
  provider: 'acs',
  failureReason: 'provider 503',
  emailError: 'delivery-failed',
};

const ELITE: NotificationBuilder = {
  id: 'b-elite',
  tenantKey: 'elite',
  displayName: 'Elite Craft Builders',
  status: 'active',
};
const OTHER: NotificationBuilder = {
  id: 'b-other',
  tenantKey: 'other',
  displayName: 'Other Homes',
  status: 'active',
};

interface FakeMember {
  userId: string;
  email: string;
  builderId: string;
  role: 'builder_admin' | 'builder_member';
  active: boolean;
  prefs?: Partial<BuilderNotificationPreferences>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface FakeRow extends Mutable<BuilderNotificationRecord> {
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
}

function emptyFeed(): BuilderLeadsNeedsYouResponse {
  return {
    uncontacted: [],
    stale: [],
    wonWithoutContract: [],
    staleAfterDays: 7,
    counts: { all: 0, new: 0, contacted: 0, quoted: 0, won: 0, lost: 0 },
  } as unknown as BuilderLeadsNeedsYouResponse;
}

function feedItem(id: string, name: string, waitingSince: Date): BuilderLeadNeedsYouItem {
  return {
    id,
    name,
    email: `${id}@homeowner.example`,
    phone: '403-555-0100',
    timeline: '3-6 months',
    leadScore: 50,
    status: 'new',
    addressKey: '1412 PROSPECT AV SW',
    createdAt: waitingSince.toISOString(),
    statusChangedAt: waitingSince.toISOString(),
    waitingSince: waitingSince.toISOString(),
  };
}

function world(opts?: {
  enabled?: boolean;
  members?: FakeMember[];
  leads?: NotificationLead[];
  deliveries?: EmailDelivery[];
  feeds?: Record<string, BuilderLeadsNeedsYouResponse>;
  community?: (addressKey: string) => Promise<string | null>;
  maxAttempts?: number;
  storeFails?: boolean;
}) {
  let now = NOW;
  const builders = [ELITE, OTHER];
  const members: FakeMember[] = opts?.members ?? [
    { userId: 'u-admin', email: 'admin@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true },
    { userId: 'u-member', email: 'member@elite.example', builderId: ELITE.id, role: 'builder_member', active: true },
    { userId: 'u-other', email: 'owner@other.example', builderId: OTHER.id, role: 'builder_admin', active: true },
  ];
  const leads = new Map<string, NotificationLead>(
    (opts?.leads ?? [
      {
        id: 'lead-1',
        name: 'Jane Q Homeowner',
        builderId: ELITE.id,
        quarantined: false,
        discarded: false,
        sandbox: false,
        addressKey: '1412 PROSPECT AV SW',
        projectType: 'new_build',
      },
    ]).map((l) => [l.id, l]),
  );
  const rows: FakeRow[] = [];
  const newLeadSends: BuilderNewLeadEmailInput[] = [];
  const digestSends: BuilderNeedsYouDigestEmailInput[] = [];
  const deliveries = [...(opts?.deliveries ?? [])];
  const errors: string[] = [];

  const toMember = (m: FakeMember): NotificationMember => ({
    userId: m.userId,
    email: m.email,
    role: m.role,
    preferences: { ...DEFAULT_BUILDER_NOTIFICATION_PREFERENCES, ...m.prefs },
  });
  const guard = () => {
    if (opts?.storeFails) throw new Error('connection refused for admin@elite.example');
  };

  const store: BuilderNotificationStore = {
    async findBuilder(id) {
      return builders.find((b) => b.id === id) ?? null;
    },
    async findBuilderByTenantKey(key) {
      return builders.find((b) => b.tenantKey === key) ?? null;
    },
    async listActiveMembers(builderId) {
      guard();
      return members.filter((m) => m.builderId === builderId && m.active).map(toMember);
    },
    async findActiveMember(builderId, who) {
      const m = members.find(
        (x) =>
          x.builderId === builderId &&
          x.active &&
          ('email' in who ? x.email === who.email.toLowerCase() : x.userId === who.userId),
      );
      return m ? toMember(m) : null;
    },
    async savePreferences(args) {
      const m = members.find((x) => x.userId === args.userId && x.builderId === args.builderId)!;
      m.prefs = { ...args.preferences };
    },
    async listDigestBuilders() {
      return builders.filter((b) =>
        members.some((m) => m.builderId === b.id && m.active && m.prefs?.needsYouDigest === true),
      );
    },
    async findLead(id) {
      guard();
      return leads.get(id) ?? null;
    },
    async enqueue(newRows) {
      for (const r of newRows) {
        if (rows.some((x) => x.dedupeKey === r.dedupeKey)) continue;
        rows.push({ ...r, status: 'pending', attempts: 0, createdAt: now, lastAttemptAt: null, lastErrorCode: null });
      }
    },
    async listPending(args) {
      return rows
        .filter(
          (r) =>
            r.status === 'pending' &&
            r.createdAt >= args.createdAfter &&
            r.attempts < args.maxAttempts &&
            (r.lastAttemptAt === null || r.lastAttemptAt <= args.leaseCutoff) &&
            (args.leadId === undefined || r.leadId === args.leadId),
        )
        .slice(0, args.limit)
        .map((r) => ({ ...r }));
    },
    async claim(args) {
      const r = rows.find((x) => x.id === args.id);
      if (!r || r.status !== 'pending') return false;
      if (r.lastAttemptAt !== null && r.lastAttemptAt > args.leaseCutoff) return false;
      r.attempts += 1;
      r.lastAttemptAt = args.now;
      return true;
    },
    async finish(args) {
      const r = rows.find((x) => x.id === args.id)!;
      r.status = args.status;
      r.lastErrorCode = args.errorCode ?? null;
    },
    async recordFailure(args) {
      const r = rows.find((x) => x.id === args.id)!;
      r.lastErrorCode = args.errorCode;
      r.lastAttemptAt = null;
    },
  };

  const service = createBuilderNotificationsService({
    store,
    email: {
      async sendBuilderNewLead(input) {
        newLeadSends.push(input);
        return deliveries.shift() ?? OK;
      },
      async sendBuilderNeedsYouDigest(input) {
        digestSends.push(input);
        return deliveries.shift() ?? OK;
      },
    },
    needsYou: async (tenantKey) => opts?.feeds?.[tenantKey] ?? emptyFeed(),
    resolveCommunity: opts?.community ?? (async () => 'Mount Pleasant'),
    config: {
      enabled: opts?.enabled ?? true,
      maxAttempts: opts?.maxAttempts ?? 3,
      retryWindowHours: 24,
      claimLeaseMinutes: 10,
      digestLocalHour: 7,
      digestTimeZone: TZ,
    },
    onError: (message) => errors.push(message),
    clock: () => now,
  });

  return {
    service,
    store,
    rows,
    members,
    leads,
    newLeadSends,
    digestSends,
    errors,
    setNow: (d: Date) => {
      now = d;
    },
  };
}

function session(email: string, viewAsUserId?: string): NotificationSessionRef {
  return {
    email,
    tenantKey: 'elite',
    builderId: ELITE.id,
    viewAs: viewAsUserId === undefined ? null : { userId: viewAsUserId },
  };
}

describe('helpers', () => {
  it('first name only, with a neutral fallback', () => {
    expect(firstNameOf('  Jane Q Homeowner ')).toBe('Jane');
    expect(firstNameOf('   ')).toBe('A homeowner');
  });

  it('project type labels', () => {
    expect(projectTypeLabel('new_build')).toBe('New build');
    expect(projectTypeLabel('renovation')).toBe('Renovation');
    expect(projectTypeLabel('comparison')).toBe('Home project');
  });

  it('local day and hour follow the configured zone, across midnight', () => {
    expect(localDayAndHour(new Date('2026-11-16T06:30:00Z'), TZ)).toEqual({
      day: '2026-11-15',
      hour: 23,
    });
    expect(localDayAndHour(new Date('2026-11-16T14:00:00Z'), TZ)).toEqual({
      day: '2026-11-16',
      hour: 7,
    });
    expect(localDayAndHour(new Date('2026-11-16T00:05:00Z'), 'UTC')).toEqual({
      day: '2026-11-16',
      hour: 0,
    });
  });
});

describe('new-lead email (AC1, AC2, AC4, AC5)', () => {
  it('sends one email to each opted-in active member of the lead\'s builder', async () => {
    const w = world();
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(w.newLeadSends.map((s) => s.to).sort()).toEqual([
      'admin@elite.example',
      'member@elite.example',
    ]);
    expect(w.rows.every((r) => r.status === 'sent')).toBe(true);
  });

  it('carries first name, community, project type and the lead id — no contact details', async () => {
    const w = world();
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    const input = w.newLeadSends[0]!;
    expect(input).toEqual({
      to: expect.any(String),
      firstName: 'Jane',
      community: 'Mount Pleasant',
      projectType: 'New build',
      builderName: 'Elite Craft Builders',
      leadId: 'lead-1',
    });
    expect(JSON.stringify(input)).not.toContain('Homeowner');
  });

  it('falls back to "Calgary" when the community lookup fails', async () => {
    const w = world({
      community: async () => {
        throw new Error('City API down');
      },
    });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(w.newLeadSends[0]!.community).toBe('Calgary');
  });

  it('a resubmission of the same lead sends nothing more', async () => {
    const w = world();
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(w.newLeadSends).toHaveLength(2);
    expect(w.rows).toHaveLength(2);
  });

  it('skips members who turned new-lead email off and inactive members', async () => {
    const w = world({
      members: [
        { userId: 'u1', email: 'on@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true },
        { userId: 'u2', email: 'off@elite.example', builderId: ELITE.id, role: 'builder_member', active: true, prefs: { newLeadEmail: false } },
        { userId: 'u3', email: 'gone@elite.example', builderId: ELITE.id, role: 'builder_member', active: false },
      ],
    });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(w.newLeadSends.map((s) => s.to)).toEqual(['on@elite.example']);
  });

  it('a member who turns it off after the event is skipped at send time', async () => {
    const w = world({ deliveries: [FAIL, OK] });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    // One send failed and stays pending for the timer.
    const pending = w.rows.find((r) => r.status === 'pending')!;
    const member = w.members.find((m) => m.userId === pending.userId)!;
    member.prefs = { newLeadEmail: false };
    w.setNow(new Date(NOW.getTime() + 30 * MIN));
    const before = w.newLeadSends.length;
    const result = await w.service.runCycle();
    expect(w.newLeadSends).toHaveLength(before);
    expect(result.skipped).toBe(1);
    expect(pending.userId).toBeDefined();
    expect(w.rows.find((r) => r.id === pending.id)!.status).toBe('skipped');
  });

  it('never notifies for quarantined, discarded, sandbox or mismatched leads', async () => {
    const base = {
      name: 'Sam',
      builderId: ELITE.id,
      quarantined: false,
      discarded: false,
      sandbox: false,
      addressKey: 'x',
      projectType: 'new_build',
    };
    const w = world({
      leads: [
        { ...base, id: 'q', quarantined: true },
        { ...base, id: 'd', discarded: true },
        { ...base, id: 's', sandbox: true },
        { ...base, id: 'm', builderId: OTHER.id },
      ],
    });
    for (const id of ['q', 'd', 's', 'm']) {
      await w.service.notifyNewLead({ leadId: id, builderId: ELITE.id });
    }
    expect(w.newLeadSends).toHaveLength(0);
    expect(w.rows).toHaveLength(0);
  });

  it('reassigning a lead to another builder notifies that builder once', async () => {
    const w = world();
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    w.leads.set('lead-1', { ...w.leads.get('lead-1')!, builderId: OTHER.id });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: OTHER.id });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: OTHER.id });
    expect(w.newLeadSends.filter((s) => s.to === 'owner@other.example')).toHaveLength(1);
  });

  it('a pending email for a lead reassigned away is skipped, not sent', async () => {
    const w = world({ deliveries: [FAIL, FAIL] });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    w.leads.set('lead-1', { ...w.leads.get('lead-1')!, builderId: OTHER.id });
    w.setNow(new Date(NOW.getTime() + 30 * MIN));
    await w.service.runCycle();
    expect(w.newLeadSends).toHaveLength(2);
    expect(w.rows.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('a provider failure resolves quietly and the timer retries it', async () => {
    const w = world({
      members: [{ userId: 'u1', email: 'admin@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true }],
      deliveries: [FAIL, OK],
    });
    await expect(
      w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id }),
    ).resolves.toBeUndefined();
    expect(w.rows[0]!.status).toBe('pending');
    expect(w.rows[0]!.lastErrorCode).toBe('delivery-failed');
    w.setNow(new Date(NOW.getTime() + 30 * MIN));
    const result = await w.service.runCycle();
    expect(result.sent).toBe(1);
    expect(w.rows[0]!.status).toBe('sent');
    expect(w.newLeadSends).toHaveLength(2);
  });

  it('stops retrying after maxAttempts and marks the row failed', async () => {
    const w = world({
      members: [{ userId: 'u1', email: 'admin@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true }],
      deliveries: [FAIL, FAIL, FAIL, FAIL],
      maxAttempts: 2,
    });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    w.setNow(new Date(NOW.getTime() + 30 * MIN));
    await w.service.runCycle();
    w.setNow(new Date(NOW.getTime() + 60 * MIN));
    await w.service.runCycle();
    expect(w.newLeadSends).toHaveLength(2);
    expect(w.rows[0]!.status).toBe('failed');
  });

  it('an invalid recipient fails at once (no retries)', async () => {
    const w = world({
      members: [{ userId: 'u1', email: 'admin@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true }],
      deliveries: [{ ...FAIL, emailError: 'invalid-recipient' }],
    });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(w.rows[0]!.status).toBe('failed');
  });

  it('accepted-but-unconfirmed counts as sent (no duplicate)', async () => {
    const w = world({
      members: [{ userId: 'u1', email: 'admin@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true }],
      deliveries: [{ ...FAIL, acceptedByProvider: true }],
    });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(w.rows[0]!.status).toBe('sent');
  });

  it('a store failure never throws into the lead flow, and the sink gets no PII', async () => {
    const w = world({ storeFails: true });
    await expect(
      w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id }),
    ).resolves.toBeUndefined();
    expect(w.errors).toHaveLength(1);
    expect(w.errors[0]).not.toContain('@');
  });

  it('concurrent deliveries of the same row send once (claim lease)', async () => {
    const w = world({
      members: [{ userId: 'u1', email: 'admin@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true }],
    });
    await Promise.all([
      w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id }),
      w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id }),
      w.service.runCycle(),
    ]);
    expect(w.newLeadSends).toHaveLength(1);
  });

  it('does nothing when the feature is switched off', async () => {
    const w = world({ enabled: false });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(await w.service.runCycle()).toEqual({ sent: 0, skipped: 0, failed: 0, digestsQueued: 0 });
    expect(w.rows).toHaveLength(0);
    expect(await w.service.billingRecipients('elite')).toEqual([]);
  });
});

describe('daily "Needs you" digest (AC3)', () => {
  const feed = (): BuilderLeadsNeedsYouResponse => ({
    ...emptyFeed(),
    uncontacted: [feedItem('lead-a', 'Ana Smith', new Date(NOW.getTime() - 50 * HOUR))],
    stale: [feedItem('lead-b', 'Bo Lee', new Date(NOW.getTime() - 9 * 24 * HOUR))],
  });
  const digestMembers = (): FakeMember[] => [
    { userId: 'u1', email: 'digest@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true, prefs: { needsYouDigest: true } },
    { userId: 'u2', email: 'nodigest@elite.example', builderId: ELITE.id, role: 'builder_member', active: true },
  ];

  it('sends once per opted-in member per local day, listing only feed leads', async () => {
    const w = world({ members: digestMembers(), feeds: { elite: feed() } });
    const first = await w.service.runCycle();
    expect(first.digestsQueued).toBe(1);
    expect(w.digestSends).toHaveLength(1);
    const input = w.digestSends[0]!;
    expect(input.to).toBe('digest@elite.example');
    expect(input.uncontacted).toEqual([{ firstName: 'Ana', waitingDays: 2, leadId: 'lead-a' }]);
    expect(input.stale).toEqual([{ firstName: 'Bo', waitingDays: 9, leadId: 'lead-b' }]);
    expect(input.wonWithoutContract).toEqual([]);
    expect(JSON.stringify(input)).not.toMatch(/homeowner\.example|403-555/);

    w.setNow(new Date(NOW.getTime() + 30 * MIN));
    await w.service.runCycle();
    expect(w.digestSends).toHaveLength(1);

    // Next local day: a new digest.
    w.setNow(new Date(NOW.getTime() + 24 * HOUR));
    await w.service.runCycle();
    expect(w.digestSends).toHaveLength(2);
  });

  it('is not sent when the feed is empty', async () => {
    const w = world({ members: digestMembers(), feeds: { elite: emptyFeed() } });
    const result = await w.service.runCycle();
    expect(result.digestsQueued).toBe(0);
    expect(w.digestSends).toHaveLength(0);
  });

  it('waits for the configured local hour', async () => {
    const w = world({ members: digestMembers(), feeds: { elite: feed() } });
    w.setNow(new Date('2026-11-16T13:30:00Z')); // 06:30 local
    await w.service.runCycle();
    expect(w.digestSends).toHaveLength(0);
  });

  it('a failed digest is retried the same day and skipped once the feed empties', async () => {
    const feeds: Record<string, BuilderLeadsNeedsYouResponse> = { elite: feed() };
    const w = world({ members: digestMembers(), feeds, deliveries: [FAIL] });
    await w.service.runCycle();
    expect(w.rows[0]!.status).toBe('pending');
    feeds['elite'] = emptyFeed();
    w.setNow(new Date(NOW.getTime() + 30 * MIN));
    await w.service.runCycle();
    expect(w.rows[0]!.status).toBe('skipped');
    expect(w.rows[0]!.lastErrorCode).toBe('feed-empty');
  });
});

describe('preferences (AC4)', () => {
  it('returns the defaults for a member who never saved', async () => {
    const w = world();
    expect(await w.service.getPreferences(session('member@elite.example'))).toEqual({
      channel: 'email',
      preferences: { newLeadEmail: true, needsYouDigest: false, billingEmail: true },
      role: 'builder_member',
      canDisableBillingEmail: true,
    });
  });

  it('a partial update keeps the other fields and stops new-lead email', async () => {
    const w = world();
    const res = await w.service.updatePreferences(session('member@elite.example'), {
      newLeadEmail: false,
    });
    expect(res.preferences).toEqual({ newLeadEmail: false, needsYouDigest: false, billingEmail: true });
    await w.service.notifyNewLead({ leadId: 'lead-1', builderId: ELITE.id });
    expect(w.newLeadSends.map((s) => s.to)).toEqual(['admin@elite.example']);
  });

  it('the last admin receiving billing emails cannot turn them off (409)', async () => {
    const w = world();
    const view = await w.service.getPreferences(session('admin@elite.example'));
    expect(view.canDisableBillingEmail).toBe(false);
    const err = await w.service
      .updatePreferences(session('admin@elite.example'), { billingEmail: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).code).toBe('LAST_ADMIN');
  });

  it('an admin may turn billing off when another admin still gets it', async () => {
    const w = world({
      members: [
        { userId: 'a1', email: 'a1@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true },
        { userId: 'a2', email: 'a2@elite.example', builderId: ELITE.id, role: 'builder_admin', active: true },
      ],
    });
    const res = await w.service.updatePreferences(session('a1@elite.example'), { billingEmail: false });
    expect(res.preferences.billingEmail).toBe(false);
    expect(await w.service.billingRecipients('elite')).toEqual(['a2@elite.example']);
    // Now a2 is the last one.
    expect((await w.service.getPreferences(session('a2@elite.example'))).canDisableBillingEmail).toBe(false);
  });

  it('billing recipients are active admins with billing on — never members', async () => {
    const w = world();
    expect(await w.service.billingRecipients('elite')).toEqual(['admin@elite.example']);
    expect(await w.service.billingRecipients('unknown')).toEqual([]);
  });

  it('rejects unknown fields and non-boolean values (400)', async () => {
    const w = world();
    for (const body of [{ sms: true }, { newLeadEmail: 'no' }, null]) {
      const err = await w.service
        .updatePreferences(session('member@elite.example'), body)
        .catch((e: unknown) => e);
      expect((err as HttpError).status).toBe(400);
    }
  });

  it('403 for a session that is not an active member, and for writes while viewing as', async () => {
    const w = world();
    const notMember = await w.service
      .getPreferences(session('stranger@example.com'))
      .catch((e: unknown) => e);
    expect((notMember as HttpError).status).toBe(403);
    // Reading while viewing as a teammate shows the teammate's preferences…
    const viewed = await w.service.getPreferences(session('admin@elite.example', 'u-member'));
    expect(viewed.role).toBe('builder_member');
    // …but changing them is refused.
    const write = await w.service
      .updatePreferences(session('admin@elite.example', 'u-member'), { newLeadEmail: false })
      .catch((e: unknown) => e);
    expect((write as HttpError).status).toBe(403);
  });
});
