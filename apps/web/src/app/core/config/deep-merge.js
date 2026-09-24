/** True for plain JSON-style objects — the only valid shape for a config override. */
export function isPlainObject(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
export function deepMerge(base, override) {
    if (override === undefined)
        return base;
    if (override === null)
        return override; // explicit "no value"
    if (isPlainObject(base) && isPlainObject(override)) {
        const result = { ...base };
        for (const key of Object.keys(override)) {
            if (!(key in result))
                continue; // unknown keys are dropped
            const baseValue = result[key];
            const overrideValue = override[key];
            if (overrideValue === undefined)
                continue;
            result[key] = deepMerge(baseValue, overrideValue);
        }
        return result;
    }
    // Arrays replace wholesale, but only by other arrays.
    if (Array.isArray(base) || Array.isArray(override)) {
        return (Array.isArray(base) && Array.isArray(override) ? override : base);
    }
    // Primitives replace only on a type match — a mistyped override is dropped.
    return (typeof base === typeof override ? override : base);
}
