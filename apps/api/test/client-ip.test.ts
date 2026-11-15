/**
 * Client IP resolution (#729).
 *
 * The left-most `X-Forwarded-For` entries are whatever the caller sent; the
 * Azure front end appends the real peer address on the right. These tests
 * pin that a spoofed chain can never choose the rate-limit key.
 */
import { describe, expect, it } from 'vitest';
import { clientIpFromHeaders } from '../src/middleware/client-ip';

describe('clientIpFromHeaders (#729)', () => {
  it('returns the single platform-set address', () => {
    expect(clientIpFromHeaders({ 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('takes the right-most (platform-appended) hop, ignoring spoofed left entries', () => {
    expect(
      clientIpFromHeaders({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9, 203.0.113.7' }),
    ).toBe('203.0.113.7');
  });

  it('rotating the spoofed prefix never changes the key', () => {
    const keys = new Set<string | undefined>();
    for (let i = 0; i < 30; i += 1) {
      keys.add(clientIpFromHeaders({ 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }));
    }
    expect([...keys]).toEqual(['203.0.113.7']);
  });

  it('strips a port from IPv4 and bracketed IPv6 hops', () => {
    expect(clientIpFromHeaders({ 'x-forwarded-for': 'evil, 203.0.113.7:51234' })).toBe(
      '203.0.113.7',
    );
    expect(clientIpFromHeaders({ 'x-forwarded-for': '[2001:db8::1]:443' })).toBe('2001:db8::1');
  });

  it('keeps a bare IPv6 address intact', () => {
    expect(clientIpFromHeaders({ 'x-forwarded-for': 'x, 2001:db8::1' })).toBe('2001:db8::1');
  });

  it('joins repeated header values in order before picking the last hop', () => {
    expect(
      clientIpFromHeaders({ 'x-forwarded-for': ['6.6.6.6', '203.0.113.7'] }),
    ).toBe('203.0.113.7');
  });

  it('matches the header name case-insensitively', () => {
    expect(clientIpFromHeaders({ 'X-Forwarded-For': '1.1.1.1, 203.0.113.7' })).toBe(
      '203.0.113.7',
    );
  });

  it('returns undefined for a missing, empty, or non-IP trusted hop', () => {
    expect(clientIpFromHeaders(undefined)).toBeUndefined();
    expect(clientIpFromHeaders({})).toBeUndefined();
    expect(clientIpFromHeaders({ 'x-forwarded-for': ' , ' })).toBeUndefined();
    expect(clientIpFromHeaders({ 'x-forwarded-for': '203.0.113.7, not-an-ip' })).toBeUndefined();
  });

  it('ignores a client-supplied X-Client-IP style header (only XFF is read)', () => {
    expect(
      clientIpFromHeaders({ 'x-client-ip': '6.6.6.6', 'x-forwarded-for': '203.0.113.7' }),
    ).toBe('203.0.113.7');
  });
});
