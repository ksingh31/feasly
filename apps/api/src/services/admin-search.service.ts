/**
 * Admin global search (⌘K palette) — business logic.
 *
 * Normalizes the query, decides which entity kinds the caller may see
 * (permission-gated per kind), runs the per-kind store queries in
 * parallel, and maps rows to typed hits with display labels. Hits carry
 * labels and IDs only — never dollar figures, rates, or credentials.
 *
 * Kind gates (on top of the route's staff-only `leads:read` gate):
 * - lead     → `leads:read`
 * - invoice  → `billing:read`
 * - builder  → `builders:read`
 * - user     → `users:manage`
 */
import type { AdminSearchHit, AdminSearchHitKind } from '@feasly/contracts';
import type { Permission } from '../auth/permissions';
import type { AdminSearchPatterns, AdminSearchStore } from './admin-search.store';

export interface AdminSearchServiceDeps {
  readonly store: AdminSearchStore;
  readonly config: { readonly maxHitsPerKind: number };
}

export interface AdminSearchService {
  /**
   * Search every kind the caller's permissions allow. `query` must already
   * be trimmed and validated (1–100 chars) by the route.
   */
  search(query: string, permissions: readonly Permission[]): Promise<AdminSearchHit[]>;
}

/** Permission required to see each hit kind. */
export const ADMIN_SEARCH_KIND_PERMISSIONS: Record<AdminSearchHitKind, Permission> = {
  lead: 'leads:read',
  invoice: 'billing:read',
  builder: 'builders:read',
  user: 'users:manage',
};

/** Escape LIKE metacharacters so user input is matched literally. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Lowercase, collapse runs of non-alphanumerics into `-`, trim dashes. */
export function slugifyTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildPatterns(query: string): AdminSearchPatterns {
  const slug = slugifyTerm(query);
  return {
    text: `%${escapeLike(query)}%`,
    // Only add a slug pattern when it differs from the raw text — saves a
    // redundant OR when the user already typed a slug.
    slug: slug && slug !== query.toLowerCase() ? `%${escapeLike(slug)}%` : null,
  };
}

export function createAdminSearchService(deps: AdminSearchServiceDeps): AdminSearchService {
  const { store, config } = deps;
  const limit = config.maxHitsPerKind;

  return {
    async search(query, permissions) {
      const can = (kind: AdminSearchHitKind): boolean =>
        permissions.includes(ADMIN_SEARCH_KIND_PERMISSIONS[kind]);
      const p = buildPatterns(query);

      const [leadRows, invoiceRows, builderRows, userRows] = await Promise.all([
        can('lead') ? store.searchLeads(p, limit) : Promise.resolve([]),
        can('invoice') ? store.searchInvoices(p, limit) : Promise.resolve([]),
        can('builder') ? store.searchBuilders(p, limit) : Promise.resolve([]),
        can('user') ? store.searchUsers(p, limit) : Promise.resolve([]),
      ]);

      return [
        ...leadRows.map(
          (r): AdminSearchHit => ({
            kind: 'lead',
            id: r.id,
            label: r.name,
            sublabel: [r.email, r.addressKey].filter(Boolean).join(' · ') || null,
          }),
        ),
        ...invoiceRows.map(
          (r): AdminSearchHit => ({
            kind: 'invoice',
            id: r.id,
            label: r.invoiceNumber,
            sublabel: `${r.tenantKey} · ${r.status}`,
          }),
        ),
        ...builderRows.map(
          (r): AdminSearchHit => ({
            kind: 'builder',
            id: r.id,
            label: r.displayName,
            sublabel:
              r.businessName && r.businessName !== r.displayName
                ? `${r.businessName} · ${r.tenantKey}`
                : r.tenantKey,
          }),
        ),
        ...userRows.map(
          (r): AdminSearchHit => ({
            kind: 'user',
            id: r.id,
            label: r.name,
            sublabel: r.email,
          }),
        ),
      ];
    },
  };
}
