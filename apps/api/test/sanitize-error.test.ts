/**
 * Error-message sanitizer tests (admin/05).
 *
 * The sanitizer is the single gate between worker errors and the ops panel /
 * `sheets_sync_runs` table. AC4 requires failure text with no credentials
 * and no PII. Tests pin every redaction branch.
 */
import { describe, expect, it } from 'vitest';
import {
  sanitizeErrorMessage,
  SANITIZED_ERROR_MAX_LENGTH,
} from '../src/lib/sanitize-error';

describe('sanitizeErrorMessage', () => {
  it('redacts lead email addresses (PII)', () => {
    const out = sanitizeErrorMessage(
      new Error('failed to sync lead user@example.com: 403'),
    );
    expect(out).not.toContain('user@example.com');
    expect(out).toContain('[redacted-email]');
  });

  it('redacts api_key-style assignments', () => {
    const out = sanitizeErrorMessage(
      'Google API error: api_key=AIzaSyD-abc123XYZ denied',
    );
    expect(out).not.toContain('AIzaSyD-abc123XYZ');
    expect(out).toContain('[redacted]');
  });

  it('redacts Bearer tokens', () => {
    const out = sanitizeErrorMessage(
      'auth failed: Bearer ya29.a0AfH6SMBx-example-token',
    );
    expect(out).not.toContain('ya29.a0AfH6SMBx-example-token');
    expect(out).toContain('Bearer [redacted]');
  });

  it('redacts PEM private-key blocks (service-account keys)', () => {
    const out = sanitizeErrorMessage(
      'bad key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh\n-----END PRIVATE KEY-----',
    );
    expect(out).not.toContain('MIIEvQIBADANBgkqh');
    expect(out).toContain('[redacted-key]');
  });

  it('redacts long opaque tokens (JWTs)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlF_7Uya0gE';
    const out = sanitizeErrorMessage(`token rejected: ${jwt}`);
    expect(out).not.toContain(jwt.slice(0, 40));
    expect(out).toContain('[redacted-token]');
  });

  it('keeps short human-readable text intact', () => {
    const out = sanitizeErrorMessage(
      new Error('Sheets API quota exceeded (429)'),
    );
    expect(out).toContain('quota exceeded');
    expect(out).toContain('429');
  });

  it('collapses multiline errors to one line', () => {
    const out = sanitizeErrorMessage('line one\n  line two\r\nline three');
    expect(out).toBe('line one line two line three');
  });

  it('truncates to the max length', () => {
    const out = sanitizeErrorMessage(new Error('x'.repeat(1000)));
    expect(out.length).toBeLessThanOrEqual(SANITIZED_ERROR_MAX_LENGTH);
  });

  it('never returns empty — falls back to the constructor name', () => {
    expect(sanitizeErrorMessage(new TypeError(''))).toBe('TypeError');
  });

  it('handles non-Error thrown values', () => {
    expect(sanitizeErrorMessage('plain string failure')).toBe(
      'plain string failure',
    );
    expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
  });
});
