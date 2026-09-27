/**
 * Community display-name helper (SEO/shared).
 *
 * City names arrive as SCREAMING_CASE ("MCKENZIE TOWNE", "DOUGLASDALE/GLEN").
 * This renders them as display names ("McKenzie Towne", "Douglasdale/Glen")
 * for page titles, meta descriptions, and JSON-LD. Shared (not duplicated)
 * between the community page and the communities index.
 */
export function toDisplayName(name: string): string {
  return name
    .toLowerCase()
    .split(/([ /-]+)/)
    .map((part) => {
      if (/^[ /-]+$/.test(part) || part.length === 0) return part;
      // Mc/Mac prefix: "mckenzie" -> "McKenzie"
      const mc = part.match(/^(mc|mac)([a-z].*)$/);
      if (mc) return mc[1][0]!.toUpperCase() + mc[1].slice(1) + mc[2][0]!.toUpperCase() + mc[2].slice(1);
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join('');
}
