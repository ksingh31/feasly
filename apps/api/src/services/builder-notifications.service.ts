/**
 * Builder notifications (#725): new-lead email, daily "Needs you" digest,
 * per-member email preferences, and billing-email recipients.
 *
 * Owner decisions (2026-11-15): email only (no SMS); new-lead email ON by
 * default for every active builder member (opt-out); digest OFF by default
 * (opt-in); new-lead email carries first name, community, project type and
 * a deep link — never the homeowner's email or phone.
 *
 * Delivery model — send-once outbox (`builder_notifications`):
 *   - an event (embed lead captured, admin assigns a lead) enqueues one row
 *     per opted-in active member, keyed `new_lead:<lead>:<builder>:<user>`.
 *     ON CONFLICT DO NOTHING makes a resubmitted lead or a repeated
 *     assignment a no-op (AC1, AC2);
 *   - delivery claims each row (conditional UPDATE with a lease) so the
 *     in-request attempt and the retry timer never both send it;
 *   - a provider failure leaves the row pending (attempt counted) and the
 *     builder-notifications timer retries it until `maxAttempts` (AC5). The
 *     email service already retries transient failures in-call;
 *   - preferences, membership and the lead's assignment are re-checked at
 *     send time, so a member who turned the email off gets nothing (AC4)
 *     and a lead reassigned in the meantime is skipped.
 *
 * Nothing here throws into the lead flow: `notifyNewLead` swallows every
 * failure into the sanitized `onError` sink.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  BuilderLeadNeedsYouItem,
  BuilderLeadsNeedsYouResponse,
  BuilderNotificationPreferences,
  BuilderNotificationPreferencesResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type {
  BuilderNotificationRecord,
  BuilderNotificationStore,
  NotificationBuilder,
  NotificationLead,
  NotificationMember,
} from './builder-notification.store';
import type { EmailService } from './email/email.service';
import type { BuilderDigestLeadLine } from './email/templates';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** Digest rows are only worth retrying on the day they were built. */
const DIGEST_RETRY_MAX_AGE_HOURS = 12;
/** Lines listed per digest group before "and N more". */
const DIGEST_MAX_PER_GROUP = 10;
/** Pending rows handled per timer tick (backpressure). */
const RETRY_BATCH_LIMIT = 200;

export interface BuilderNotificationsServiceDeps {
  readonly store: BuilderNotificationStore;
  readonly email: Pick<EmailService, 'sendBuilderNewLead' | 'sendBuilderNeedsYouDigest'>;
  /** The builder's "Needs you" feed — the digest lists only these leads. */
  readonly needsYou: (tenantKey: string) => Promise<BuilderLeadsNeedsYouResponse>;
  /**
   * City community for a lead's address key. Optional — the email says
   * "Calgary" when absent, null, or the lookup fails.
   */
  readonly resolveCommunity?: (addressKey: string) => Promise<string | null>;
  readonly config: {
    readonly enabled: boolean;
    readonly maxAttempts: number;
    readonly retryWindowHours: number;
    readonly claimLeaseMinutes: number;
    readonly digestLocalHour: number;
    readonly digestTimeZone: string;
  };
  /** Sanitized failure sink — never emails, names or tokens. */
  readonly onError?: (message: string) => void;
  readonly clock?: () => Date;
}

/** The builder-portal session fields this service needs. */
export interface NotificationSessionRef {
  readonly email: string;
  readonly tenantKey: string;
  readonly builderId: string | null;
  readonly viewAs: { readonly userId?: string } | null;
}

export interface NotificationCycleResult {
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly digestsQueued: number;
}

export interface BuilderNotificationsService {
  getPreferences(session: NotificationSessionRef): Promise<BuilderNotificationPreferencesResponse>;
  updatePreferences(
    session: NotificationSessionRef,
    body: unknown,
  ): Promise<BuilderNotificationPreferencesResponse>;
  /**
   * A lead was captured for (or assigned to) a builder: enqueue one new-lead
   * email per opted-in active member and attempt delivery. Never throws.
   */
  notifyNewLead(args: { readonly leadId: string; readonly builderId: string }): Promise<void>;
  /**
   * Timer tick: retry pending rows, and build + send the daily digest once
   * the local digest hour has been reached (once per local day).
   */
  runCycle(): Promise<NotificationCycleResult>;
  /**
   * Billing-email recipients for a tenant: active builder admins with
   * billing email on. Empty when none (or the feature is off) — the caller
   * falls back to the org's billing contact.
   */
  billingRecipients(tenantKey: string): Promise<readonly string[]>;
}

export const BuilderNotificationPreferencesUpdateSchema = z
  .object({
    newLeadEmail: z.boolean().optional(),
    needsYouDigest: z.boolean().optional(),
    billingEmail: z.boolean().optional(),
  })
  .strict();

/** First name only — the email never carries the full name. */
export function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : 'A homeowner';
}

export function projectTypeLabel(projectType: string): string {
  if (projectType === 'new_build') return 'New build';
  if (projectType === 'renovation') return 'Renovation';
  return 'Home project';
}

/** Local date (YYYY-MM-DD) and hour in an IANA zone. */
export function localDayAndHour(
  now: Date,
  timeZone: string,
): { readonly day: string; readonly hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  };
}

export function newLeadDedupeKey(leadId: string, builderId: string, userId: string): string {
  return `new_lead:${leadId}:${builderId}:${userId}`;
}

export function digestDedupeKey(day: string, builderId: string, userId: string): string {
  return `needs_you_digest:${day}:${builderId}:${userId}`;
}

function feedIsEmpty(feed: BuilderLeadsNeedsYouResponse): boolean {
  return (
    feed.uncontacted.length === 0 &&
    feed.stale.length === 0 &&
    feed.wonWithoutContract.length === 0
  );
}

function sanitize(error: unknown): string {
  // Class name only: driver/provider messages can echo addresses.
  return error instanceof Error ? error.name : 'unknown';
}

type Outcome = 'sent' | 'skipped' | 'failed' | 'retry' | 'busy';

export function createBuilderNotificationsService(
  deps: BuilderNotificationsServiceDeps,
): BuilderNotificationsService {
  const { store, email, needsYou, resolveCommunity, config } = deps;
  const onError = deps.onError ?? ((message: string) => console.warn(message));
  const clock = deps.clock ?? (() => new Date());

  // ── Preferences ────────────────────────────────────────────────────────

  async function resolveMember(
    session: NotificationSessionRef,
  ): Promise<{ builder: NotificationBuilder; member: NotificationMember }> {
    const builder =
      session.builderId !== null
        ? await store.findBuilder(session.builderId)
        : await store.findBuilderByTenantKey(session.tenantKey);
    if (builder === null) {
      throw new HttpError(403, ErrorCodes.FORBIDDEN, 'No builder org for this session.', false);
    }
    const viewAsUserId = session.viewAs?.userId;
    const member = await store.findActiveMember(
      builder.id,
      viewAsUserId !== undefined ? { userId: viewAsUserId } : { email: session.email },
    );
    if (member === null) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'You are not an active member of this builder org.',
        false,
      );
    }
    return { builder, member };
  }

  async function otherAdminsWithBilling(builderId: string, userId: string): Promise<number> {
    const members = await store.listActiveMembers(builderId);
    return members.filter(
      (m) => m.userId !== userId && m.role === 'builder_admin' && m.preferences.billingEmail,
    ).length;
  }

  async function toResponse(
    builder: NotificationBuilder,
    member: NotificationMember,
    preferences: BuilderNotificationPreferences,
  ): Promise<BuilderNotificationPreferencesResponse> {
    const canDisableBillingEmail =
      member.role !== 'builder_admin' ||
      !preferences.billingEmail ||
      (await otherAdminsWithBilling(builder.id, member.userId)) > 0;
    return {
      channel: 'email',
      preferences,
      role: member.role,
      canDisableBillingEmail,
    };
  }

  // ── Delivery ───────────────────────────────────────────────────────────

  /** Per-call caches so a batch looks each lead/builder/community up once. */
  function createLookups() {
    const leads = new Map<string, Promise<NotificationLead | null>>();
    const builders = new Map<string, Promise<NotificationBuilder | null>>();
    const communities = new Map<string, Promise<string>>();
    const feeds = new Map<string, Promise<BuilderLeadsNeedsYouResponse>>();
    const memo = <T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
      let hit = map.get(key);
      if (hit === undefined) {
        hit = load();
        map.set(key, hit);
      }
      return hit;
    };
    return {
      lead: (id: string) => memo(leads, id, () => store.findLead(id)),
      builder: (id: string) => memo(builders, id, () => store.findBuilder(id)),
      community: (addressKey: string) =>
        memo(communities, addressKey, async () => {
          if (resolveCommunity === undefined) return 'Calgary';
          try {
            const name = (await resolveCommunity(addressKey))?.trim();
            return name !== undefined && name.length > 0 ? name : 'Calgary';
          } catch {
            return 'Calgary';
          }
        }),
      feed: (tenantKey: string, preset?: BuilderLeadsNeedsYouResponse) =>
        memo(feeds, tenantKey, () =>
          preset !== undefined ? Promise.resolve(preset) : needsYou(tenantKey),
        ),
    };
  }
  type Lookups = ReturnType<typeof createLookups>;

  function waitingDays(item: BuilderLeadNeedsYouItem, now: Date): number {
    const since = Date.parse(item.waitingSince);
    if (Number.isNaN(since)) return 0;
    return Math.max(0, Math.floor((now.getTime() - since) / MS_PER_DAY));
  }

  function digestLines(
    items: readonly BuilderLeadNeedsYouItem[],
    now: Date,
  ): BuilderDigestLeadLine[] {
    return items.map((item) => ({
      firstName: firstNameOf(item.name),
      waitingDays: waitingDays(item, now),
      leadId: item.id,
    }));
  }

  /**
   * One delivery attempt for one outbox row. Returns the outcome; never
   * throws for a provider failure (infrastructure errors propagate to the
   * caller's per-row catch).
   */
  async function deliver(row: BuilderNotificationRecord, lookups: Lookups): Promise<Outcome> {
    const now = clock();
    const leaseCutoff = new Date(now.getTime() - config.claimLeaseMinutes * 60_000);
    if (!(await store.claim({ id: row.id, now, leaseCutoff }))) return 'busy';
    const attempt = row.attempts + 1;
    try {
      return await deliverClaimed(row, lookups, now, attempt);
    } catch (error) {
      // The claim already counted this attempt. On the last allowed attempt
      // the row would never be listed again, so mark it failed rather than
      // leave it pending forever (best-effort; the original error wins).
      if (attempt >= config.maxAttempts) {
        await store
          .finish({ id: row.id, status: 'failed', at: clock(), errorCode: 'delivery-error' })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async function deliverClaimed(
    row: BuilderNotificationRecord,
    lookups: Lookups,
    now: Date,
    attempt: number,
  ): Promise<Outcome> {

    const skip = async (reason: string): Promise<Outcome> => {
      await store.finish({ id: row.id, status: 'skipped', at: clock(), errorCode: reason });
      return 'skipped';
    };

    const builder = await lookups.builder(row.builderId);
    if (builder === null || builder.status !== 'active') return skip('builder-inactive');
    const member = await store.findActiveMember(row.builderId, { userId: row.userId });
    if (member === null) return skip('not-a-member');

    let delivery;
    if (row.kind === 'new_lead') {
      if (!member.preferences.newLeadEmail) return skip('opted-out');
      const lead = row.leadId === null ? null : await lookups.lead(row.leadId);
      if (lead === null || lead.quarantined || lead.discarded || lead.sandbox) {
        return skip('lead-ineligible');
      }
      if (lead.builderId !== row.builderId) return skip('reassigned');
      delivery = await email.sendBuilderNewLead({
        to: member.email,
        firstName: firstNameOf(lead.name),
        community: await lookups.community(lead.addressKey),
        projectType: projectTypeLabel(lead.projectType),
        builderName: builder.displayName,
        leadId: lead.id,
      });
    } else {
      if (!member.preferences.needsYouDigest) return skip('opted-out');
      if (now.getTime() - row.createdAt.getTime() > DIGEST_RETRY_MAX_AGE_HOURS * MS_PER_HOUR) {
        return skip('expired');
      }
      const feed = await lookups.feed(builder.tenantKey);
      if (feedIsEmpty(feed)) return skip('feed-empty');
      delivery = await email.sendBuilderNeedsYouDigest({
        to: member.email,
        builderName: builder.displayName,
        uncontacted: digestLines(feed.uncontacted, now),
        stale: digestLines(feed.stale, now),
        wonWithoutContract: digestLines(feed.wonWithoutContract, now),
        staleAfterDays: feed.staleAfterDays,
        maxPerGroup: DIGEST_MAX_PER_GROUP,
      });
    }

    // Accepted-but-unconfirmed counts as sent: a resend would most likely
    // duplicate a delivered email (same rule as the nudge and lead gate).
    if (delivery.sent || delivery.acceptedByProvider) {
      await store.finish({ id: row.id, status: 'sent', at: clock() });
      return 'sent';
    }
    if (delivery.emailError === 'invalid-recipient' || attempt >= config.maxAttempts) {
      await store.finish({
        id: row.id,
        status: 'failed',
        at: clock(),
        errorCode: delivery.emailError,
      });
      return 'failed';
    }
    await store.recordFailure({ id: row.id, errorCode: delivery.emailError });
    return 'retry';
  }

  async function deliverAll(
    rows: readonly BuilderNotificationRecord[],
    lookups: Lookups,
  ): Promise<{ sent: number; skipped: number; failed: number }> {
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const outcome = await deliver(row, lookups);
        if (outcome === 'sent') sent++;
        else if (outcome === 'skipped') skipped++;
        else if (outcome === 'failed' || outcome === 'retry') failed++;
      } catch (error) {
        // One bad row must not stop the batch. The row keeps its claim
        // until the lease expires, then the timer retries it.
        onError(`builder-notifications: delivery error (${row.kind}, ${sanitize(error)})`);
        failed++;
      }
    }
    return { sent, skipped, failed };
  }

  function pendingWindow(now: Date) {
    return {
      createdAfter: new Date(now.getTime() - config.retryWindowHours * MS_PER_HOUR),
      leaseCutoff: new Date(now.getTime() - config.claimLeaseMinutes * 60_000),
      maxAttempts: config.maxAttempts,
      limit: RETRY_BATCH_LIMIT,
    };
  }

  async function queueDigests(
    now: Date,
    lookups: Lookups,
  ): Promise<{ queued: number; keys: string[] }> {
    const { day, hour } = localDayAndHour(now, config.digestTimeZone);
    if (hour < config.digestLocalHour) return { queued: 0, keys: [] };
    const keys: string[] = [];
    for (const builder of await store.listDigestBuilders()) {
      try {
        const members = (await store.listActiveMembers(builder.id)).filter(
          (m) => m.preferences.needsYouDigest,
        );
        if (members.length === 0) continue;
        const feed = await lookups.feed(builder.tenantKey);
        // AC3: no digest for an empty feed.
        if (feedIsEmpty(feed)) continue;
        const rows = members.map((m) => ({
          id: randomUUID(),
          dedupeKey: digestDedupeKey(day, builder.id, m.userId),
          kind: 'needs_you_digest' as const,
          builderId: builder.id,
          userId: m.userId,
          leadId: null,
        }));
        await store.enqueue(rows);
        keys.push(...rows.map((r) => r.dedupeKey));
      } catch (error) {
        onError(`builder-notifications: digest build failed (${sanitize(error)})`);
      }
    }
    return { queued: keys.length, keys };
  }

  return {
    async getPreferences(session) {
      const { builder, member } = await resolveMember(session);
      return toResponse(builder, member, member.preferences);
    },

    async updatePreferences(session, body) {
      if (session.viewAs?.userId !== undefined) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          "You can't change a teammate's notification preferences while viewing as them.",
          false,
        );
      }
      const parsed = BuilderNotificationPreferencesUpdateSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid notification preferences.',
          false,
        );
      }
      const { builder, member } = await resolveMember(session);
      const current = member.preferences;
      const next: BuilderNotificationPreferences = {
        newLeadEmail: parsed.data.newLeadEmail ?? current.newLeadEmail,
        needsYouDigest: parsed.data.needsYouDigest ?? current.needsYouDigest,
        billingEmail: parsed.data.billingEmail ?? current.billingEmail,
      };
      // AC4: the org's last admin receiving billing emails can't opt out.
      if (
        member.role === 'builder_admin' &&
        current.billingEmail &&
        !next.billingEmail &&
        (await otherAdminsWithBilling(builder.id, member.userId)) === 0
      ) {
        throw new HttpError(
          409,
          ErrorCodes.LAST_ADMIN,
          'Billing emails must reach at least one admin. Ask another admin to turn them on before you turn them off.',
          false,
        );
      }
      await store.savePreferences({
        userId: member.userId,
        builderId: builder.id,
        preferences: next,
        at: clock(),
      });
      return toResponse(builder, member, next);
    },

    async notifyNewLead({ leadId, builderId }) {
      if (!config.enabled) return;
      try {
        const lead = await store.findLead(leadId);
        if (
          lead === null ||
          lead.builderId !== builderId ||
          lead.quarantined ||
          lead.discarded ||
          lead.sandbox
        ) {
          return;
        }
        const members = (await store.listActiveMembers(builderId)).filter(
          (m) => m.preferences.newLeadEmail,
        );
        if (members.length === 0) return;
        await store.enqueue(
          members.map((m) => ({
            id: randomUUID(),
            dedupeKey: newLeadDedupeKey(leadId, builderId, m.userId),
            kind: 'new_lead' as const,
            builderId,
            userId: m.userId,
            leadId,
          })),
        );
        const now = clock();
        const pending = await store.listPending({ ...pendingWindow(now), leadId });
        await deliverAll(
          pending.filter((row) => row.kind === 'new_lead' && row.builderId === builderId),
          createLookups(),
        );
      } catch (error) {
        // AC5: never fail the lead flow; the timer retries pending rows.
        onError(`builder-notifications: new-lead notify failed (${sanitize(error)})`);
      }
    },

    async runCycle() {
      if (!config.enabled) return { sent: 0, skipped: 0, failed: 0, digestsQueued: 0 };
      const lookups = createLookups();
      const now = clock();
      const digests = await queueDigests(now, lookups);
      const pending = await store.listPending(pendingWindow(now));
      const counts = await deliverAll(pending, lookups);
      return { ...counts, digestsQueued: digests.queued };
    },

    async billingRecipients(tenantKey) {
      if (!config.enabled) return [];
      const builder = await store.findBuilderByTenantKey(tenantKey);
      if (builder === null) return [];
      const members = await store.listActiveMembers(builder.id);
      return members
        .filter((m) => m.role === 'builder_admin' && m.preferences.billingEmail)
        .map((m) => m.email);
    },
  };
}
