/**
 * Typed deep merge for configuration objects.
 *
 * Rules:
 * - Plain objects merge recursively.
 * - Arrays are REPLACED wholesale, never merged — but only by arrays.
 * - `undefined` overrides are ignored (the base value survives).
 * - `null` overrides replace (explicit "no value").
 * - Keys present in the override but absent from the base are ignored, so a
 *   stale/unknown JSON key can never introduce untyped config.
 * - A mistyped override (e.g. `"sqftDefault": "2200"`) is dropped in favor
 *   of the base value, so deploy JSON can never silently break the typed
 *   config contract at runtime.
 */
/**
 * Deep-partial: every level optional, so a JSON override can omit anything.
 * Arrays are left intact (replaced wholesale, never merged element-wise).
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** True for plain JSON-style objects — the only valid shape for a config override. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) return base;
  if (override === null) return override as T; // explicit "no value"
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      if (!(key in result)) continue; // unknown keys are dropped
      const baseValue = result[key];
      const overrideValue = (override as Record<string, unknown>)[key];
      if (overrideValue === undefined) continue;
      result[key] = deepMerge(baseValue, overrideValue as never);
    }
    return result as T;
  }
  // Arrays replace wholesale, but only by other arrays.
  if (Array.isArray(base) || Array.isArray(override)) {
    return (Array.isArray(base) && Array.isArray(override) ? override : base) as T;
  }
  // Primitives replace only on a type match — a mistyped override is dropped.
  return (typeof base === typeof override ? override : base) as T;
}
