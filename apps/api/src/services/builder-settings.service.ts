/**
 * Builder portal Settings service (#870 — API half of #724).
 *
 * - Profile & branding: any org member reads; org owners
 *   (`builder:settings:manage`) change display name, contact email/phone,
 *   logo URL (https), accent colour (#rrggbb) and the billing address
 *   (#881 — re-synced to the Stripe customer). Never rate, plan, status
 *   or origins. Audit-logged under the acting user. The embed config reads
 *   the builders row directly (no cache), so the widget reflects a change
 *   on its next load.
 * - Embed: the install snippet + allowed origins (read-only) with each
 *   origin's last `embed_loaded` and whether that falls inside the live
 *   window (BUILDER_EMBED_LIVE_WINDOW_DAYS, default 7).
 * - Origin-change requests: origins stay staff-controlled for the pilot
 *   (owner decision 2026-11-15). A request creates exactly one admin task
 *   (`builder_change_requests`, idempotent while open), is audit-logged,
 *   and emails the team inbox once. The email is best-effort — a failed
 *   send never fails the request (the task is already recorded).
 * - #860 "Close my account": an org owner asks Feasly to close the
 *   account. One open admin task per builder (`account_closure`), audit-
 *   logged, team inbox emailed. No self-serve deletion: an admin runs the
 *   offboarding from the console.
 * - Support contact comes from config (email only, "within 1 business day").
 *
 * No PII in logs: contact details never appear in log lines or audit rows.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  Builder,
  BuilderAccountClosureResponse,
  BuilderEmbedResponse,
  BuilderOriginRequest,
  BuilderOriginRequestResponse,
  BuilderProfile,
  BuilderProfileResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { parseEmbedOrigin } from '../lib/embed-origin';
import { billingAddressFieldSchema } from '../lib/billing-address';
import type { BuilderProfilePatch, BuilderService } from './builder.service';
import type { AdminAuditStore } from './admin-audit.store';
import type { EmailService } from './email/email.service';
import type {
  BuilderSettingsStore,
  OriginChangeRequestRecord,
} from './builder-settings.store';

/** Who is acting, resolved by the route from the session. */
export interface BuilderSettingsActor {
  readonly builderId: string;
  readonly userId: string | null;
  readonly email: string;
  /** True when the caller holds `builder:settings:manage`. */
  readonly canEdit: boolean;
}

export interface BuilderSettingsService {
  getProfile(actor: BuilderSettingsActor): Promise<BuilderProfileResponse>;
  updateProfile(actor: BuilderSettingsActor, body: unknown): Promise<BuilderProfileResponse>;
  getEmbed(actor: BuilderSettingsActor): Promise<BuilderEmbedResponse>;
  requestOriginChange(
    actor: BuilderSettingsActor,
    body: unknown,
  ): Promise<BuilderOriginRequestResponse>;
  /** #860: an org owner asks Feasly to close the account (idempotent while open). */
  requestAccountClosure(
    actor: BuilderSettingsActor,
    body: unknown,
  ): Promise<BuilderAccountClosureResponse>;
  /**
   * Admin changed a builder's allowed origins: close the open requests the
   * new list satisfies (every add present, every remove gone).
   */
  resolveSatisfiedOriginRequests(args: {
    readonly builderId: string;
    readonly allowedOrigins: readonly string[];
    readonly actorEmail: string;
  }): Promise<number>;
}

export interface BuilderSettingsConfigDeps {
  readonly supportEmail: string;
  readonly supportResponseTime: string;
  readonly embedLiveWindowDays: number;
  readonly embedLoaderUrl: string;
  /** Team inbox that receives "origin change requested" notices. */
  readonly opsInbox: string;
  /** Admin console base for the email's deep link. */
  readonly appBaseUrl: string;
}

export interface BuilderSettingsServiceDeps {
  readonly builders: Pick<BuilderService, 'getBuilder' | 'updateProfile'>;
  readonly store: BuilderSettingsStore;
  readonly audit: Pick<AdminAuditStore, 'log'>;
  readonly email: Pick<EmailService, 'sendOpsAlert'>;
  readonly config: BuilderSettingsConfigDeps;
  readonly clock?: () => Date;
  readonly logWarning?: (message: string) => void;
}

/** Max origins per add/remove list in one request. */
export const MAX_ORIGINS_PER_REQUEST = 10;
/** Max length of the free-text note for staff. */
export const MAX_ORIGIN_REQUEST_NOTE = 500;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PHONE_RE = /^[0-9+().\-\s]{7,40}$/;
const DAY_MS = 86_400_000;

/** '' and null both clear an optional field. */
const blankToNull = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? null : v;

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((v) => new URL(v).protocol === 'https:', { message: 'must be https' });

const ProfileUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    contactEmail: z.preprocess(
      blankToNull,
      z.string().trim().toLowerCase().email().max(254).nullable(),
    ).optional(),
    contactPhone: z.preprocess(
      blankToNull,
      z.string().trim().regex(PHONE_RE).nullable(),
    ).optional(),
    logoUrl: z.preprocess(blankToNull, httpsUrl.nullable()).optional(),
    accentColor: z.preprocess(
      blankToNull,
      z.string().trim().regex(HEX_COLOR_RE).transform((v) => v.toLowerCase()).nullable(),
    ).optional(),
    /** #881: billing address (CA postal code + province validated). */
    billingAddress: billingAddressFieldSchema,
  })
  .strict();

/** Max length of the optional note on a closure request. */
export const MAX_CLOSURE_NOTE = 1000;

const ClosureRequestSchema = z
  .object({ reason: z.string().trim().max(MAX_CLOSURE_NOTE).optional() })
  .strict();

const OriginRequestSchema = z
  .object({
    add: z.array(z.string()).max(MAX_ORIGINS_PER_REQUEST).optional(),
    remove: z.array(z.string()).max(MAX_ORIGINS_PER_REQUEST).optional(),
    note: z.string().trim().max(MAX_ORIGIN_REQUEST_NOTE).optional(),
  })
  .strict();

function badRequest(detail: string): HttpError {
  return new HttpError(400, ErrorCodes.VALIDATION_FAILED, detail, false);
}

function forbidden(detail: string): HttpError {
  return new HttpError(403, ErrorCodes.FORBIDDEN, detail, false);
}

function toProfile(b: Builder): BuilderProfile {
  return {
    tenantKey: b.tenantKey,
    businessName: b.businessName,
    displayName: b.displayName,
    contactEmail: b.email,
    contactPhone: b.phone,
    logoUrl: b.logoUrl,
    accentColor: b.accentColor,
    billingAddress: b.billingAddress ?? null,
    updatedAt: b.updatedAt,
  };
}

function toRequest(r: OriginChangeRequestRecord): BuilderOriginRequest {
  return {
    id: r.id,
    status: r.status,
    add: [...r.add],
    remove: [...r.remove],
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Parse + canonicalize + de-duplicate a list of origins (400 on any bad one). */
function parseOrigins(list: readonly string[] | undefined, field: string): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const origin = parseEmbedOrigin(raw);
    if (origin === null) {
      throw badRequest(
        `Each ${field} entry must be a secure (https) site origin with no path, e.g. the address bar up to the domain.`,
      );
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out.sort();
}

/** HTML-attribute-safe (tenant keys are slugs, but never trust a value). */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function createBuilderSettingsService(
  deps: BuilderSettingsServiceDeps,
): BuilderSettingsService {
  const { builders, store, audit, email, config } = deps;
  const clock = deps.clock ?? (() => new Date());
  const warn = deps.logWarning ?? ((m: string) => console.warn(m));

  function support(): BuilderProfileResponse['support'] {
    return {
      channel: 'email',
      email: config.supportEmail,
      responseTime: config.supportResponseTime,
    };
  }

  function requireOwner(actor: BuilderSettingsActor, what: string): void {
    if (!actor.canEdit) {
      throw forbidden(`Only your organization's owners can ${what}.`);
    }
  }

  async function notifyOrigins(
    builder: Builder,
    record: OriginChangeRequestRecord,
  ): Promise<void> {
    const parts: string[] = [];
    if (record.add.length > 0) parts.push(`add ${record.add.join(', ')}`);
    if (record.remove.length > 0) parts.push(`remove ${record.remove.join(', ')}`);
    try {
      const delivery = await email.sendOpsAlert({
        to: config.opsInbox,
        title: `Embed origin change requested — ${builder.displayName}`,
        summary:
          `${builder.displayName} (${builder.tenantKey}) asked to ${parts.join(' and ')}. ` +
          `Request ${record.id}. Apply it from the builder's embed origins in the admin console.`,
        detailsUrl: `${config.appBaseUrl.replace(/\/+$/, '')}/admin/builders`,
        firedAt: record.createdAt,
      });
      if (!delivery.sent) {
        warn(
          `builder-settings: origin-request notice not sent for requestId=${record.id} ` +
            `(${delivery.failureReason})`,
        );
      }
    } catch (error) {
      warn(
        `builder-settings: origin-request notice failed for requestId=${record.id} ` +
          `(${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
  }

  return {
    async getProfile(actor) {
      const builder = await builders.getBuilder(actor.builderId);
      return { profile: toProfile(builder), canEdit: actor.canEdit, support: support() };
    },

    async updateProfile(actor, body) {
      requireOwner(actor, 'change the profile');
      const parsed = ProfileUpdateSchema.safeParse(body ?? {});
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join('.') || 'body';
        // Field path only — never echo the submitted value.
        throw badRequest(`Invalid profile field '${where}'.`);
      }
      const d = parsed.data;
      const patch: BuilderProfilePatch = {
        ...(d.displayName !== undefined ? { displayName: d.displayName } : {}),
        ...(d.contactEmail !== undefined ? { email: d.contactEmail } : {}),
        ...(d.contactPhone !== undefined ? { phone: d.contactPhone } : {}),
        ...(d.logoUrl !== undefined ? { logoUrl: d.logoUrl } : {}),
        ...(d.accentColor !== undefined ? { accentColor: d.accentColor } : {}),
        ...(d.billingAddress !== undefined ? { billingAddress: d.billingAddress } : {}),
      };
      if (Object.keys(patch).length === 0) {
        throw badRequest('Send at least one profile field to change.');
      }
      const updated = await builders.updateProfile(actor.builderId, patch, actor.email);
      return { profile: toProfile(updated), canEdit: true, support: support() };
    },

    async getEmbed(actor) {
      const builder = await builders.getBuilder(actor.builderId);
      const origins = [...builder.allowedOrigins];
      const [loads, open] = await Promise.all([
        store.lastEmbedLoads(builder.tenantKey, origins),
        store.listOpenOriginRequests(builder.id),
      ]);
      const byOrigin = new Map(loads.map((l) => [l.origin, l.lastSeenAt]));
      const cutoff = clock().getTime() - config.embedLiveWindowDays * DAY_MS;
      let latest: Date | null = null;
      const statuses = origins.map((origin) => {
        const seen = byOrigin.get(origin) ?? null;
        if (seen && (!latest || seen > latest)) latest = seen;
        return {
          origin,
          lastSeenAt: seen ? seen.toISOString() : null,
          loadedRecently: seen !== null && seen.getTime() >= cutoff,
        };
      });
      const allowed = new Set(origins);
      // Hide requests an admin already applied (they're closed on the next
      // admin update; this keeps the portal honest in between).
      const pending = open.filter(
        (r) => !(r.add.every((o) => allowed.has(o)) && r.remove.every((o) => !allowed.has(o))),
      );
      const lastSeen = latest as Date | null;
      return {
        tenantKey: builder.tenantKey,
        loaderUrl: config.embedLoaderUrl,
        snippet:
          `<script src="${attr(config.embedLoaderUrl)}"\n` +
          `        data-builder="${attr(builder.tenantKey)}"></script>`,
        origins: statuses,
        liveWindowDays: config.embedLiveWindowDays,
        lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
        openRequests: pending.map(toRequest),
      };
    },

    async requestOriginChange(actor, body) {
      requireOwner(actor, 'request embed origin changes');
      const parsed = OriginRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join('.') || 'body';
        throw badRequest(
          `Invalid origin request at '${where}' (up to ${MAX_ORIGINS_PER_REQUEST} origins per list, note up to ${MAX_ORIGIN_REQUEST_NOTE} characters).`,
        );
      }
      const add = parseOrigins(parsed.data.add, 'add');
      const remove = parseOrigins(parsed.data.remove, 'remove');
      if (add.length === 0 && remove.length === 0) {
        throw badRequest('Name at least one origin to add or remove.');
      }
      if (add.some((o) => remove.includes(o))) {
        throw badRequest('An origin can’t be both added and removed.');
      }
      const builder = await builders.getBuilder(actor.builderId);
      const allowed = new Set(builder.allowedOrigins);
      const alreadyAllowed = add.filter((o) => allowed.has(o));
      if (alreadyAllowed.length > 0) {
        throw badRequest(`Already allowed: ${alreadyAllowed.join(', ')}.`);
      }
      const notAllowed = remove.filter((o) => !allowed.has(o));
      if (notAllowed.length > 0) {
        throw badRequest(`Not currently allowed: ${notAllowed.join(', ')}.`);
      }
      const note = parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null;
      const dedupeKey = createHash('sha256')
        .update(JSON.stringify({ kind: 'embed_origins', add, remove }))
        .digest('hex');
      const { record, created } = await store.createOriginRequest({
        builderId: builder.id,
        add,
        remove,
        note,
        dedupeKey,
        requestedByUserId: actor.userId,
        requestedByEmail: actor.email,
      });
      if (created) {
        await audit.log({
          actorEmail: actor.email,
          action: 'builder_origin_change_requested',
          detail:
            `builderId=${builder.id} tenantKey=${builder.tenantKey} requestId=${record.id} ` +
            `add=${record.add.length} remove=${record.remove.length}`,
        });
        await notifyOrigins(builder, record);
      }
      return { request: toRequest(record), created };
    },

    async requestAccountClosure(actor, body) {
      requireOwner(actor, 'ask to close the account');
      const parsed = ClosureRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw badRequest(`reason must be text of up to ${MAX_CLOSURE_NOTE} characters.`);
      }
      const builder = await builders.getBuilder(actor.builderId);
      const note = parsed.data.reason && parsed.data.reason.length > 0 ? parsed.data.reason : null;
      const { record, created } = await store.createClosureRequest({
        builderId: builder.id,
        note,
        requestedByUserId: actor.userId,
        requestedByEmail: actor.email,
      });
      if (created) {
        await audit.log({
          actorEmail: actor.email,
          action: 'builder_account_closure_requested',
          detail: `builderId=${builder.id} tenantKey=${builder.tenantKey} requestId=${record.id}`,
        });
        try {
          const delivery = await email.sendOpsAlert({
            to: config.opsInbox,
            title: `Account closure requested — ${builder.displayName}`,
            summary:
              `${builder.displayName} (${builder.tenantKey}) asked to close their Feasly account. ` +
              `Request ${record.id}. Start offboarding from the builder in the admin console.`,
            detailsUrl: `${config.appBaseUrl.replace(/\/+$/, '')}/admin/builders`,
            firedAt: record.createdAt,
          });
          if (!delivery.sent) {
            warn(
              `builder-settings: closure notice not sent for requestId=${record.id} ` +
                `(${delivery.failureReason})`,
            );
          }
        } catch (error) {
          warn(
            `builder-settings: closure notice failed for requestId=${record.id} ` +
              `(${error instanceof Error ? error.message : 'unknown error'})`,
          );
        }
      }
      return { requestId: record.id, created, requestedAt: record.createdAt.toISOString() };
    },

    async resolveSatisfiedOriginRequests({ builderId, allowedOrigins, actorEmail }) {
      const allowed = new Set(allowedOrigins);
      const open = await store.listOpenOriginRequests(builderId);
      const satisfied = open
        .filter((r) => r.add.every((o) => allowed.has(o)) && r.remove.every((o) => !allowed.has(o)))
        .map((r) => r.id);
      return store.markOriginRequestsDone(satisfied, actorEmail, clock());
    },
  };
}
