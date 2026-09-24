/**
 * Legal-copy drift guard (legal/02, AC6).
 *
 * While copy is in DRAFT (pending lawyer review), this test asserts:
 *  1. Every draft block in `apps/api/src/lib/legal-copy.ts` carries the
 *     structural `draft-pending-lawyer` marker — draft copy can never be
 *     mistaken for approved copy.
 *  2. `docs/legal/approved-copy.md` exists and is still in the
 *     `LEGAL_REVIEW_PENDING` state — the attach point is real.
 *
 * When the lawyer approves copy, this file is upgraded to a byte-compare:
 * the API constants must byte-match the approved sections in
 * `docs/legal/approved-copy.md`, and any drift fails the build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERASURE_CONSEQUENCES_DRAFT,
  RETENTION_RULES_DRAFT,
} from '../src/lib/legal-copy';

// Resolved from the package dir (vitest/npm run test execute with cwd set
// to apps/api) — avoids import.meta, which the api tsconfig module setting
// does not allow.
const approvedCopyPath = join(
  process.cwd(),
  '..',
  '..',
  'docs',
  'legal',
  'approved-copy.md',
);

describe('draft legal copy (pending lawyer review)', () => {
  it('marks every retention rule as draft-pending-lawyer', () => {
    expect(RETENTION_RULES_DRAFT.length).toBeGreaterThan(0);
    for (const rule of RETENTION_RULES_DRAFT) {
      expect(rule.status).toBe('draft-pending-lawyer');
      expect(rule.record.length).toBeGreaterThan(0);
      expect(rule.retention.length).toBeGreaterThan(0);
    }
  });

  it('marks the erasure consequences statement as draft-pending-lawyer', () => {
    expect(ERASURE_CONSEQUENCES_DRAFT.status).toBe('draft-pending-lawyer');
    expect(ERASURE_CONSEQUENCES_DRAFT.statements.length).toBeGreaterThan(0);
    for (const s of ERASURE_CONSEQUENCES_DRAFT.statements) {
      expect(s.length).toBeGreaterThan(20);
    }
  });

  it('keeps an explicit approval attach point in docs/legal/approved-copy.md', () => {
    const md = readFileSync(approvedCopyPath, 'utf8');
    expect(md).toContain('LEGAL_REVIEW_PENDING');
    expect(md).toContain('pending lawyer review');
    expect(md).toContain('byte-compare');
  });
});
