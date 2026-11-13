import { describe, expect, it } from 'vitest';
import type { NewBuildEstimateRequest, PreviewEstimateResponse } from '@feasly/contracts';
import { cachedPreviewFor, previewRequestKey } from './preview-cache';

/** #489: the preview cache matches on the exact request (and tenant when asked). */
describe('preview-cache', () => {
  const request: NewBuildEstimateRequest = {
    projectType: 'new_build',
    property: { addressKey: 'calgary-1', assessedLandValue: 500000, lotSizeSqft: 5000, zoning: 'R-CG' },
    scope: { buildSqft: 2200, tier: 'standard', garage: 'double', basement: 'unfinished' },
  };
  const preview = { estimateId: 'est-1' } as PreviewEstimateResponse;
  const entry = { preview, key: previewRequestKey(request), tenantKey: null };

  it('keys are independent of property order and exclude the tenant', () => {
    const reordered = {
      scope: { basement: 'unfinished', garage: 'double', tier: 'standard', buildSqft: 2200 },
      property: { zoning: 'R-CG', lotSizeSqft: 5000, assessedLandValue: 500000, addressKey: 'calgary-1' },
      projectType: 'new_build',
      tenantKey: 'acme',
    } as NewBuildEstimateRequest;
    expect(previewRequestKey(reordered)).toBe(previewRequestKey(request));
  });

  it('returns the cached preview for the identical request', () => {
    expect(cachedPreviewFor(entry, request)).toBe(preview);
    expect(cachedPreviewFor(entry, request, null)).toBe(preview);
  });

  it('misses when any input differs', () => {
    expect(cachedPreviewFor(entry, { ...request, scope: { ...request.scope, buildSqft: 2300 } })).toBeNull();
    expect(
      cachedPreviewFor(entry, { ...request, property: { ...request.property, addressKey: 'calgary-2' } }),
    ).toBeNull();
  });

  it('misses when the cache is empty or has no key (state from older versions)', () => {
    expect(cachedPreviewFor({ preview: null, key: entry.key, tenantKey: null }, request)).toBeNull();
    expect(cachedPreviewFor({ preview, key: null, tenantKey: null }, request)).toBeNull();
  });

  it('requires the same tenant only when one is passed', () => {
    const tenanted = { ...entry, tenantKey: 'acme' };
    expect(cachedPreviewFor(tenanted, request, 'acme')).toBe(preview);
    expect(cachedPreviewFor(tenanted, request, null)).toBeNull();
    expect(cachedPreviewFor(entry, request, 'acme')).toBeNull();
    // The report has no embed context: it matches on the request alone.
    expect(cachedPreviewFor(tenanted, request)).toBe(preview);
  });
});
