import type { AppConfig, EstimateScopeItem } from '../config/app-config';

/** Drops the `hard.` / `soft.` engine prefix: `hard.demolition` → `demolition`. */
function categoryKey(key: string): string {
  return key.slice(key.indexOf('.') + 1);
}

/**
 * #824: the "Not included" entries still worth showing — config entries
 * minus any the engine now prices (an included line item with the same
 * category key). When #825 adds e.g. `hard.demolition` to the cost data,
 * "Demolition" leaves this list and shows under "includes" with no copy edit.
 */
export function notIncludedItems(scope: AppConfig['estimateScope']): readonly EstimateScopeItem[] {
  const priced = new Set(scope.includes.map((i) => categoryKey(i.key)));
  return scope.notIncluded.filter((i) => !priced.has(categoryKey(i.key)));
}

/**
 * Item labels as an in-sentence list: "a; b; c". Semicolons because
 * labels carry their own commas ("Utility connections (water, sewer, …)").
 * A leading capital is lowered unless the first word is an acronym (GST).
 */
export function scopeSentenceList(items: readonly EstimateScopeItem[]): string {
  const labels = items.map(({ label }) => {
    const first = label.split(/\s/)[0] ?? '';
    return first.length > 1 && first === first.toUpperCase()
      ? label
      : label.charAt(0).toLowerCase() + label.slice(1);
  });
  return labels.join('; ');
}

/**
 * #824: fills `{includes}` / `{notIncluded}` in copy from the generated
 * engine line items, so prose (FAQ answers + their FAQPage JSON-LD) never
 * hand-writes either list and moves with the engine (#825).
 */
export function fillScopePlaceholders(text: string, scope: AppConfig['estimateScope']): string {
  return text
    .replaceAll('{includes}', scopeSentenceList(scope.includes))
    .replaceAll('{notIncluded}', scopeSentenceList(notIncludedItems(scope)));
}
