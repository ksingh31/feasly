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
