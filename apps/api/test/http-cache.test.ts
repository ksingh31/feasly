/**
 * HTTP caching helpers (#756): weak ETag, If-None-Match matching, 200/304.
 */
import { describe, expect, it } from 'vitest';
import {
  cacheableResponse,
  ifNoneMatchHits,
  publicCacheControl,
  weakEtag,
} from '../src/lib/http-cache';

describe('http-cache (#756)', () => {
  it('weakEtag is stable for equal bodies and differs for different ones', () => {
    const a = weakEtag({ addressKey: '1 A ST NW', assessedValue: 1 });
    expect(a).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(weakEtag({ addressKey: '1 A ST NW', assessedValue: 1 })).toBe(a);
    expect(weakEtag({ addressKey: '1 A ST NW', assessedValue: 2 })).not.toBe(a);
  });

  it('ifNoneMatchHits uses weak comparison, lists and *', () => {
    const tag = 'W/"abc"';
    expect(ifNoneMatchHits(undefined, tag)).toBe(false);
    expect(ifNoneMatchHits('W/"abc"', tag)).toBe(true);
    expect(ifNoneMatchHits('"abc"', tag)).toBe(true);
    expect(ifNoneMatchHits('"x", W/"abc"', tag)).toBe(true);
    expect(ifNoneMatchHits(['"x"', 'W/"abc"'], tag)).toBe(true);
    expect(ifNoneMatchHits('*', tag)).toBe(true);
    expect(ifNoneMatchHits('W/"abd"', tag)).toBe(false);
    expect(ifNoneMatchHits('', tag)).toBe(false);
  });

  it('cacheableResponse answers 200 with headers, or 304 without a body', () => {
    const body = { suggestions: [] };
    const first = cacheableResponse(body, undefined, 3600);
    expect(first.status).toBe(200);
    expect(first.body).toBe(body);
    expect(first.headers['Cache-Control']).toBe(publicCacheControl(3600));
    expect(first.headers['Cache-Control']).toBe('public, max-age=3600');

    const again = cacheableResponse(body, first.headers.ETag, 3600);
    expect(again.status).toBe(304);
    expect(again.body).toBeUndefined();
    expect(again.headers.ETag).toBe(first.headers.ETag);
  });
});
