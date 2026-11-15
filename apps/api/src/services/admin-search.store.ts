/**
 * Admin global search persistence (⌘K palette).
 *
 * One bounded, case-insensitive substring query per entity kind. The
 * interface is what `AdminSearchService` depends on; unit tests fake it.
 * The Drizzle implementation is constructed once in composition.ts.
 *
 * Patterns arrive already escaped and wrapped (`%term%`) from the service —
 * this layer only runs the queries.
 */
import { and, asc, desc, eq, ilike, or } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { builders, commissionInvoices, leads, users } from '../db/schema';

export interface AdminSearchLeadRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly addressKey: string;
}

export interface AdminSearchInvoiceRow {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly tenantKey: string;
  readonly status: string;
}

export interface AdminSearchBuilderRow {
  readonly id: string;
  readonly displayName: string;
  readonly businessName: string;
  readonly tenantKey: string;
}

export interface AdminSearchUserRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface AdminSearchPatterns {
  /** `%term%`, LIKE-escaped. */
  readonly text: string;
  /**
   * `%term-slug%` — the term slugified (lowercase, non-alphanumerics → `-`)
   * so "123 Fake St" also matches slug-style address keys and builder
   * slugs. Null when the term has no alphanumerics.
   */
  readonly slug: string | null;
}

export interface AdminSearchStore {
  searchLeads(p: AdminSearchPatterns, limit: number): Promise<AdminSearchLeadRow[]>;
  searchInvoices(p: AdminSearchPatterns, limit: number): Promise<AdminSearchInvoiceRow[]>;
  searchBuilders(p: AdminSearchPatterns, limit: number): Promise<AdminSearchBuilderRow[]>;
  searchUsers(p: AdminSearchPatterns, limit: number): Promise<AdminSearchUserRow[]>;
}

export interface DrizzleAdminSearchStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleAdminSearchStore(
  deps: DrizzleAdminSearchStoreDeps,
): AdminSearchStore {
  const { db } = deps;

  return {
    async searchLeads(p, limit) {
      const address = p.slug
        ? or(ilike(leads.addressKey, p.text), ilike(leads.addressKey, p.slug))
        : ilike(leads.addressKey, p.text);
      // Same visibility as the default admin lead listing: no sandbox,
      // quarantined (honeypot) or discarded rows.
      return db
        .select({
          id: leads.id,
          name: leads.name,
          email: leads.email,
          addressKey: leads.addressKey,
        })
        .from(leads)
        .where(
          and(
            eq(leads.sandbox, false),
            eq(leads.quarantined, false),
            eq(leads.discarded, false),
            or(ilike(leads.name, p.text), ilike(leads.email, p.text), address),
          ),
        )
        .orderBy(desc(leads.createdAt), asc(leads.id))
        .limit(limit);
    },

    async searchInvoices(p, limit) {
      return db
        .select({
          id: commissionInvoices.id,
          invoiceNumber: commissionInvoices.invoiceNumber,
          tenantKey: commissionInvoices.tenantKey,
          status: commissionInvoices.status,
        })
        .from(commissionInvoices)
        .where(ilike(commissionInvoices.invoiceNumber, p.text))
        .orderBy(desc(commissionInvoices.createdAt), asc(commissionInvoices.id))
        .limit(limit);
    },

    async searchBuilders(p, limit) {
      const slug = p.slug
        ? or(ilike(builders.tenantKey, p.text), ilike(builders.tenantKey, p.slug))
        : ilike(builders.tenantKey, p.text);
      return db
        .select({
          id: builders.id,
          displayName: builders.displayName,
          businessName: builders.businessName,
          tenantKey: builders.tenantKey,
        })
        .from(builders)
        .where(
          or(
            ilike(builders.displayName, p.text),
            ilike(builders.businessName, p.text),
            slug,
          ),
        )
        .orderBy(asc(builders.displayName), asc(builders.id))
        .limit(limit);
    },

    async searchUsers(p, limit) {
      return db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(or(ilike(users.name, p.text), ilike(users.email, p.text)))
        .orderBy(asc(users.name), asc(users.id))
        .limit(limit);
    },
  };
}
