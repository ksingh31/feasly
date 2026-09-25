#!/usr/bin/env node
/**
 * Legal gate (HRD-05, acceptance criterion 1).
 *
 * Fails (exit 1) when any served legal copy still carries the
 * `draft-pending-lawyer` marker — i.e. the lawyer has not reviewed and
 * approved it yet. Scanned sources:
 *   - apps/web/src/app/features/legal/*.component.ts (privacy/terms pages)
 *   - apps/api/src/lib/legal-copy.ts (PIPEDA erasure/retention copy)
 *   - docs/legal/approved-copy.md (the DRAFT banner)
 *
 * Wiring decision (documented in the HRD-05 PR): this gate blocks PRODUCTION
 * DEPLOYS (CD deploy jobs in .github/workflows/cd.yml), not PR merges.
 * Freezing every PR until the lawyer reviews would halt development; the
 * launch risk is production traffic serving draft legal copy, and that is
 * what this gate prevents.
 *
 * When it fails, the message tells Karan exactly what to do: get the lawyer
 * review, replace the draft copy, remove the markers.
 *
 * The gate is proven to bite by apps/web/tools/check-legal-gate.spec.ts
 * (vitest): it fails on a fixture carrying the marker and passes on a
 * clean fixture.
 *
 * Usage: node apps/web/tools/check-legal-gate.mjs (paths resolve from the
 * script location, so any cwd works).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS_DIR, '..', '..', '..'); // repo root

/** The structural marker. Lawyer sign-off = remove every occurrence. */
export const LEGAL_DRAFT_MARKER = 'draft-pending-lawyer';

/** Served-copy sources that must be marker-free before launch. */
export const LEGAL_SCAN_FILES = [
  'apps/web/src/app/features/legal/privacy-page.component.ts',
  'apps/web/src/app/features/legal/terms-page.component.ts',
  'apps/api/src/lib/legal-copy.ts',
  'docs/legal/approved-copy.md',
];

/** Scan a repo root for draft markers. Returns the hit descriptions. */
export function checkLegalGate(root = ROOT) {
  const hits = [];
  for (const rel of LEGAL_SCAN_FILES) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      hits.push(`${rel}: FILE MISSING (expected to exist)`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.includes(LEGAL_DRAFT_MARKER)) {
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  return hits;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const hits = checkLegalGate();
  if (hits.length > 0) {
    console.error('');
    console.error('LEGAL GATE FAILED — draft legal copy is still served.');
    console.error('');
    console.error('The lawyer has not reviewed the copy below. Production');
    console.error('deploys are blocked until every `draft-pending-lawyer`');
    console.error('marker is removed.');
    console.error('');
    console.error('What Karan needs to do:');
    console.error('  1. Have counsel review docs/legal/approved-copy.md and');
    console.error('     the privacy/terms pages + PIPEDA copy.');
    console.error('  2. Replace the draft text with the approved wording.');
    console.error('  3. Remove every `draft-pending-lawyer` marker.');
    console.error('');
    console.error('Marker hits:');
    for (const h of hits) console.error(`  - ${h}`);
    console.error('');
    process.exit(1);
  }
  console.log('Legal gate: no draft-pending-lawyer markers in served copy. OK.');
}
