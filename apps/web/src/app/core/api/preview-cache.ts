import type { AnyEstimateRequest, PreviewEstimateResponse } from '@feasly/contracts';

/**
 * Pre-gate preview cache (#489).
 *
 * The real API mints a fresh `estimateId` (UUID) on every
 * `POST /estimates/preview`, so the preview, the lead gate, and the
 * analyzing screen must share ONE preview — otherwise the lead row points at
 * a different estimate than the one the user saw. The wizard slice keeps the
 * last preview together with the canonical key of the request that produced
 * it; a caller about to run the same request reuses the cached preview
 * instead of re-minting.
 *
 * No math here: the key is a canonical serialization of the request body,
 * and the comparison is plain equality.
 */

/** Cached preview plus the identity of the request that produced it. */
export interface PreviewCacheEntry {
  readonly preview: PreviewEstimateResponse | null;
  /** Canonical request key ({@link previewRequestKey}); null when unknown. */
  readonly key: string | null;
  /** Embed tenant the preview was attributed to; null outside an embed. */
  readonly tenantKey: string | null;
}

/** Recursively sorts object keys so the serialization is order-independent. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        const v = (value as Record<string, unknown>)[k];
        if (v !== undefined && k !== 'tenantKey') {
          acc[k] = canonical(v);
        }
        return acc;
      }, {});
  }
  return value;
}

/**
 * Canonical key for an estimate request body. The embed `tenantKey` is
 * excluded — attribution is matched separately (see {@link cachedPreviewFor})
 * so the report, which has no embed context, can still recognize the
 * estimate the lead attached to.
 */
export function previewRequestKey(request: AnyEstimateRequest): string {
  return JSON.stringify(canonical(request));
}

/**
 * The cached preview when it was produced by exactly this request. Pass
 * `tenantKey` to also require the same embed attribution (gate, analyzing,
 * preview step); omit it (`undefined`) to match on the request alone.
 */
export function cachedPreviewFor(
  cache: PreviewCacheEntry,
  request: AnyEstimateRequest,
  tenantKey?: string | null,
): PreviewEstimateResponse | null {
  if (!cache.preview || cache.key === null || cache.key !== previewRequestKey(request)) {
    return null;
  }
  if (tenantKey !== undefined && (cache.tenantKey ?? null) !== (tenantKey ?? null)) {
    return null;
  }
  return cache.preview;
}
