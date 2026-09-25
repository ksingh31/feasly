/**
 * HRD-05 spec: legal gate (check-legal-gate.mjs).
 *
 * Proves the gate bites: it fails on a fixture carrying the
 * `draft-pending-lawyer` marker and passes on a clean fixture.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLegalGate,
  LEGAL_DRAFT_MARKER,
  LEGAL_SCAN_FILES,
} from './check-legal-gate.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legal-gate-'));
  // Create every scanned file with clean content.
  for (const rel of LEGAL_SCAN_FILES) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '// clean — lawyer approved\n');
  }
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
});
