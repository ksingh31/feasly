import { Directive, TemplateRef, inject, input } from '@angular/core';
import type { StatusDomain } from '../status/status-dictionary';

/**
 * How a cell renders when no `uiCell` template overrides it:
 * - `text`   — plain text, clamped to 2 lines with the full value on hover.
 * - `id`     — `nowrap` (invoice numbers, short refs).
 * - `money`  — integer cents → whole dollars, right-aligned, tabular.
 * - `count`  — thousands separators, right-aligned, tabular.
 * - `date`   — "Nov 12, 2026".
 * - `status` — a StatusChip (needs `statusDomain`).
 */
export type DataTableCellKind = 'text' | 'id' | 'money' | 'count' | 'date' | 'status';

/**
 * Where the column shows in the < 768px card list (title, chip, 2–3 meta
 * lines, chevron). Defaults: first column → `title`, the first `status`
 * column → `chip`, the next three columns → `meta`, the rest → `hidden`.
 */
export type DataTableCardRole = 'title' | 'chip' | 'meta' | 'hidden';

export interface DataTableColumn<T> {
  /** Stable key: the sort key and the `uiCell` template name. */
  readonly key: string;
  readonly header: string;
  readonly kind?: DataTableCellKind;
  readonly sortable?: boolean;
  /** Defaults to `end` for money/count, otherwise `start`. */
  readonly align?: 'start' | 'end';
  /** Cell value. Defaults to `row[key]`. */
  readonly value?: (row: T) => unknown;
  /** Required for `kind: 'status'`. */
  readonly statusDomain?: StatusDomain;
  readonly cardRole?: DataTableCardRole;
}

/** Template context for `uiCell` and `uiRowActions`. */
export interface DataTableCellContext<T> {
  readonly $implicit: T;
  readonly value: unknown;
}

/**
 * Custom cell renderer for one column (used in the table and the card list):
 *
 * ```html
 * <ng-template uiCell="builder" let-row>
 *   <ui-entity-link [label]="row.builderName" ... />
 * </ng-template>
 * ```
 */
@Directive({ selector: 'ng-template[uiCell]', standalone: true })
export class UiCellDirective<T = unknown> {
  readonly uiCell = input.required<string>();
  readonly template = inject<TemplateRef<DataTableCellContext<T>>>(TemplateRef);
}

/**
 * Row actions: one inline button plus a kebab (§3). Rendered in a trailing
 * column (table) or under the card (mobile). Clicks inside never open the row.
 */
@Directive({ selector: 'ng-template[uiRowActions]', standalone: true })
export class UiRowActionsDirective<T = unknown> {
  readonly template = inject<TemplateRef<DataTableCellContext<T>>>(TemplateRef);
}

export function columnValue<T>(column: DataTableColumn<T>, row: T): unknown {
  if (column.value) return column.value(row);
  return (row as Record<string, unknown> | null)?.[column.key];
}

export function columnAlign<T>(column: DataTableColumn<T>): 'start' | 'end' {
  return column.align ?? (column.kind === 'money' || column.kind === 'count' ? 'end' : 'start');
}

/** Max meta lines on a mobile card. */
const CARD_META_LINES = 3;

export interface DataTableCardLayout<T> {
  readonly title: DataTableColumn<T> | null;
  readonly chip: DataTableColumn<T> | null;
  readonly meta: readonly DataTableColumn<T>[];
}

/** Resolves explicit/default card roles (see {@link DataTableCardRole}). */
export function cardLayout<T>(columns: readonly DataTableColumn<T>[]): DataTableCardLayout<T> {
  const title = columns.find((c) => c.cardRole === 'title') ?? columns.find((c) => !c.cardRole) ?? null;
  const chip =
    columns.find((c) => c.cardRole === 'chip') ??
    columns.find((c) => !c.cardRole && c.kind === 'status' && c !== title) ??
    null;
  const explicitMeta = columns.filter((c) => c.cardRole === 'meta');
  const meta = explicitMeta.length
    ? explicitMeta
    : columns.filter((c) => !c.cardRole && c !== title && c !== chip);
  return { title, chip, meta: meta.slice(0, CARD_META_LINES) };
}

/** Controls inside a row whose clicks must not open it. */
const INTERACTIVE = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  '[role="button"]',
  '[role="menuitem"]',
].join(',');

/** True when a click/keydown started on something interactive inside the row. */
export function fromInteractive(event: Event, row: Element): boolean {
  const target = event.target as Element | null;
  const hit = target?.closest?.(INTERACTIVE);
  return !!hit && hit !== row && row.contains(hit);
}
