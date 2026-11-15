import type { AdminLeadFilters, AdminLeadStatus } from '@feasly/contracts';
import type { TableFilters } from '@app/shared/ui';

/**
 * Admin Leads list state (#539) — saved views and URL filters → backend
 * filters. Pure (no Angular) so the mapping is unit tested on its own.
 *
 * URL params (via `injectTableQuery`): `q` search, `view` saved view,
 * `status` and `assigned` FilterBar selects. A view is a preset; explicit
 * FilterBar values win over the preset when both set the same field.
 */

export const VIEW_PARAM = 'view';
export const STATUS_PARAM = 'status';
export const ASSIGNED_PARAM = 'assigned';
export const LEADS_FILTER_KEYS: readonly string[] = [VIEW_PARAM, STATUS_PARAM, ASSIGNED_PARAM];

/** Literal `assigned` / `builderId` value for "no builder". */
export const UNASSIGNED = 'unassigned';

export type AdminLeadsView = 'all' | 'new' | 'unassigned' | 'quoting-stale';

/** Saved views, in display order. `all` is the absence of the param. */
export const ADMIN_LEADS_VIEWS: readonly AdminLeadsView[] = ['all', 'new', 'unassigned', 'quoting-stale'];

/** Pipeline statuses in the order the team works them. */
export const PIPELINE_STATUSES: readonly AdminLeadStatus[] = ['new', 'contacted', 'quoting', 'won', 'lost'];

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseView(raw: string | undefined | null): AdminLeadsView {
  return (ADMIN_LEADS_VIEWS as readonly string[]).includes(raw ?? '') ? (raw as AdminLeadsView) : 'all';
}

export function parseStatus(raw: string | undefined | null): AdminLeadStatus | null {
  return (PIPELINE_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as AdminLeadStatus) : null;
}

/**
 * Backend filters for one saved view. `quoting-stale` = status Quoting and
 * created more than `staleDays` before `now` (the list API filters on
 * `createdBefore`; it has no status-age filter).
 */
export function viewFilters(view: AdminLeadsView, now: Date, staleDays: number): AdminLeadFilters {
  switch (view) {
    case 'new':
      return { status: 'new' };
    case 'unassigned':
      return { builderId: UNASSIGNED };
    case 'quoting-stale':
      return {
        status: 'quoting',
        createdBefore: new Date(now.getTime() - staleDays * DAY_MS).toISOString(),
      };
    default:
      return {};
  }
}

/** URL state → backend filters: view preset, then explicit filters, then search. */
export function leadsFilters(
  search: string,
  filters: TableFilters,
  now: Date,
  staleDays: number,
): AdminLeadFilters {
  const out: { -readonly [K in keyof AdminLeadFilters]: AdminLeadFilters[K] } = {
    ...viewFilters(parseView(filters[VIEW_PARAM]), now, staleDays),
  };
  const status = parseStatus(filters[STATUS_PARAM]);
  if (status) out.status = status;
  const assigned = filters[ASSIGNED_PARAM];
  if (assigned) out.builderId = assigned;
  const q = search.trim();
  if (q) out.search = q;
  return out;
}

/** `{name}`-style placeholder fill for config copy. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}
