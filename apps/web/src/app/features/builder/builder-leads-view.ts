/**
 * Leads home (#527) view helpers — pure, no Angular, no app state.
 *
 * Presentation only: picking which already-loaded rows to show (status
 * segment, search, sort, page) and formatting labels/links. No business
 * rule lives here — staleness, needs-you grouping and recording state all
 * come from the backend.
 */
import type { BuilderLeadListItem, BuilderLeadStatus } from '@feasly/contracts';
import { type LeadHeatKey, type TableSort, enumLabel } from '@app/shared/ui';

/** Pipeline statuses in the order a builder works them (segmented filter). */
export const PIPELINE_STATUSES: readonly BuilderLeadStatus[] = [
  'new',
  'contacted',
  'quoted',
  'won',
  'lost',
];

/** Sortable pipeline columns (also the allowed `sort` URL values). */
export const LEAD_SORT_KEYS = ['lead', 'activity'] as const;

/** Default pipeline order: most recent activity first. */
export const DEFAULT_LEAD_SORT: TableSort = { key: 'activity', direction: 'desc' };

export type LeadHeat = LeadHeatKey;

export interface HeatThresholds {
  readonly hotMin: number;
  readonly warmMin: number;
}

/** Display bucket for a 0–100 lead score (thresholds are config-owned). */
export function heatLevel(score: number, thresholds: HeatThresholds): LeadHeat {
  if (score >= thresholds.hotMin) return 'hot';
  if (score >= thresholds.warmMin) return 'warm';
  return 'cool';
}

/** Heat pill text ("Hot · 92") from the config labels + template. */
export function heatChipLabel(
  score: number,
  heat: HeatThresholds & Readonly<Record<LeadHeat, string>> & { readonly chipLabel: string },
): string {
  return fill(heat.chipLabel, { heat: heat[heatLevel(score, heat)], score });
}

/** Narrows a raw `status` query param to a pipeline status (anything else = All). */
export function parseStatusFilter(raw: string | undefined): BuilderLeadStatus | null {
  return raw && (PIPELINE_STATUSES as readonly string[]).includes(raw)
    ? (raw as BuilderLeadStatus)
    : null;
}

/** Digits of a string, for phone search ("403 555" matches "403-555-0101"). */
function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Case-insensitive match on name, email, address or phone. */
export function leadMatchesSearch(lead: BuilderLeadListItem, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const haystack = [lead.name, lead.email, lead.addressKey].join('\n').toLowerCase();
  if (haystack.includes(q)) return true;
  const qDigits = digits(q);
  return qDigits.length >= 3 && !!lead.phone && digits(lead.phone).includes(qDigits);
}

function compareLeads(a: BuilderLeadListItem, b: BuilderLeadListItem, key: string): number {
  if (key === 'lead') return a.name.localeCompare(b.name, 'en-CA', { sensitivity: 'base' });
  // 'activity': ISO-8601 instants compare chronologically as numbers.
  return Date.parse(a.statusUpdatedAt) - Date.parse(b.statusUpdatedAt);
}

export interface LeadListQuery {
  readonly status: BuilderLeadStatus | null;
  readonly search: string;
  readonly sort: TableSort | null;
}

/** Status segment + search + sort over the loaded pipeline. Stable; never mutates. */
export function selectPipelineLeads(
  leads: readonly BuilderLeadListItem[],
  query: LeadListQuery,
): readonly BuilderLeadListItem[] {
  const rows = leads.filter(
    (lead) =>
      (query.status === null || lead.status === query.status) &&
      leadMatchesSearch(lead, query.search),
  );
  const sort = query.sort;
  if (!sort) return rows;
  const dir = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((lead, index) => ({ lead, index }))
    .sort((x, y) => dir * compareLeads(x.lead, y.lead, sort.key) || x.index - y.index)
    .map((entry) => entry.lead);
}

/** One page (1-based) of rows; `pageSize <= 0` means no paging. */
export function pageOf<T>(rows: readonly T[], page: number, pageSize: number): readonly T[] {
  if (pageSize <= 0) return rows;
  const start = (Math.max(1, page) - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

/** Wire project type → label: the config map first, else humanised ("new_build" → "New build"). */
export function projectTypeLabel(raw: string, labels: Readonly<Record<string, string>>): string {
  return labels[raw] || enumLabel(raw);
}

/**
 * `tel:` href for a lead phone (#475). Keeps a leading `+` and digits only,
 * so "403-555-0101" / "(403) 555 0101" dial correctly on every phone.
 */
export function telHref(phone: string): string {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return 'tel:' + plus + digits(trimmed);
}

/** `mailto:` href for a lead email (#475). */
export function mailtoHref(email: string): string {
  return 'mailto:' + email.trim();
}

/** Fills `{name}`-style placeholders. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
