/**
 * HRD-05 spec: legal gate (check-legal-gate.mjs).
 *
 * Proves the gate bites: it fails on a fixture carrying the
 * `draft-pending-lawyer` marker, fails while LEGAL_REVIEW_PENDING is set,
 * and passes on a clean fixture.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLegalGate,
  LEGAL_DRAFT_MARKER,
  LEGAL_REVIEW_FLAG_PATH,
  LEGAL_SCAN_FILES,
  resolveLegalReviewPending,
} from './check-legal-gate.mjs';

let root: string;

function writeFlagConfig(reviewPending: unknown): void {
  const abs = join(root, LEGAL_REVIEW_FLAG_PATH);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify({ legal: { reviewPending } }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legal-gate-'));
  // Create every scanned file with clean content.
  for (const rel of LEGAL_SCAN_FILES) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '// clean — lawyer approved\n');
  }
  // Lawyer has signed off in the fixture: the flag is cleared.
  writeFlagConfig(false);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkLegalGate', () => {
  it('passes on a clean tree', () => {
    expect(checkLegalGate(root)).toEqual([]);
  });

  it('fails when any scanned file carries the draft marker', () => {
    const target = join(root, LEGAL_SCAN_FILES[0]);
    writeFileSync(target, `// copy status: ${LEGAL_DRAFT_MARKER}\n`);
    const hits = checkLegalGate(root);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toContain(LEGAL_SCAN_FILES[0]);
    expect(hits[0]).toContain(LEGAL_DRAFT_MARKER);
  });

  it('fails when a scanned file is missing', () => {
    rmSync(join(root, LEGAL_SCAN_FILES[2]));
    const hits = checkLegalGate(root);
    expect(hits.some((h) => h.includes('FILE MISSING'))).toBe(true);
  });

  it('reports the line number of the marker', () => {
    const target = join(root, LEGAL_SCAN_FILES[1]);
    writeFileSync(target, 'line one\nline two\n// ' + LEGAL_DRAFT_MARKER + '\n');
    const hits = checkLegalGate(root);
    expect(hits[0]).toMatch(/:3:/);
  });

  it('fails while LEGAL_REVIEW_PENDING is set', () => {
    writeFlagConfig(true);
    const hits = checkLegalGate(root);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toContain(LEGAL_REVIEW_FLAG_PATH);
    expect(hits[0]).toContain('LEGAL_REVIEW_PENDING');
  });

  it('fails closed when the flag key is absent', () => {
    writeFlagConfig(undefined);
    expect(resolveLegalReviewPending(root)).toBe(true);
    expect(checkLegalGate(root).length).toBeGreaterThan(0);
  });

  it('fails closed when the flag config file is missing', () => {
    rmSync(join(root, LEGAL_REVIEW_FLAG_PATH));
    expect(resolveLegalReviewPending(root)).toBe(true);
    expect(checkLegalGate(root).length).toBeGreaterThan(0);
  });

  it('resolves the flag from the config file', () => {
    writeFlagConfig(true);
    expect(resolveLegalReviewPending(root)).toBe(true);
    writeFlagConfig(false);
    expect(resolveLegalReviewPending(root)).toBe(false);
  });
});
