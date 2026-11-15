/** One record an EntityCombobox can pick. Pure — no Angular. */
export interface EntityOption {
  /** Record id — the form value. Never the visible label. */
  readonly id: string;
  /** Human label: invoice number, lead name, builder name. */
  readonly label: string;
  /** Secondary line, e.g. builder city or invoice amount. */
  readonly meta?: string;
}

/**
 * Case-insensitive match on label, meta, or an exact/prefix id (support
 * staff do sometimes have an id to hand). Keeps input order.
 */
export function filterEntityOptions(
  options: readonly EntityOption[],
  query: string,
): EntityOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...options];
  }
  return options.filter(
    (o) =>
      o.label.toLowerCase().includes(needle) ||
      (o.meta?.toLowerCase().includes(needle) ?? false) ||
      o.id.toLowerCase().startsWith(needle),
  );
}
