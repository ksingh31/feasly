#!/usr/bin/env node
/**
 * Legal gate (HRD-05, acceptance criterion 1; legal/01 AC3).
 *
 * Fails (exit 1) while the served legal copy is still draft — i.e. the
 * lawyer has not reviewed and approved it yet. Two signals, either one
 * trips the gate:
 *   1. The LEGAL_REVIEW_PENDING flag: `legal.reviewPending` in
 *      apps/web/public/assets/config/app-config.json. Fail-closed: a
 *      missing file, malformed JSON, or absent key counts as pending.
 *      Lawyer sign-off = set the flag to false (in the JSON and the
 *      compiled default) AND remove every draft marker below.
 *   2. The `draft-pending-lawyer` structural marker scanned in the
 *      served-copy sources (backstop: catches draft copy that someone
 *      forgot to mark via the flag).
 *
 * Scanned sources for the marker:
 *   - apps/web/src/app/features/legal/*.component.ts (privacy/terms pages)
 *   - apps/api/src/lib/legal-copy.ts (PIPEDA erasure/retention copy)
 *   - docs/legal/approved-copy.md (the DRAFT banner)
 *
 * Wiring decision (documented in the HRD-05 PR): this gate blocks PRODUCTION
 * DEPLOYS (CD deploy jobs in .github/workflows/cd.yml), not PR merges.
 * Freezing every PR until the lawyer reviews would halt development; the
 * launch risk is production traffic serving draft legal copy, and that is
 * what this gate prevents. The gate is proven to bite by
 * apps/web/tools/check-legal-gate.spec.ts (vitest), which runs in the CI
 * build job via `npm run test:tools`.
 *
 * When it fails, the message tells Karan exactly what to do: get the lawyer
 * review, replace the draft copy, flip the flag, remove the markers.
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

/**
 * Deploy config carrying the LEGAL_REVIEW_PENDING flag
 * (`legal.reviewPending`). legal/01 AC3's mechanism.
 */
export const LEGAL_REVIEW_FLAG_PATH =
  'apps/web/public/assets/config/app-config.json';

/**
 * Resolve the LEGAL_REVIEW_PENDING flag for a repo root.
 * Fail-closed: missing file, malformed JSON, or an absent/non-boolean key
 * all resolve to true (pending) — the gate must never pass on ambiguity.
 */
export function resolveLegalReviewPending(root = ROOT) {
  const abs = join(root, LEGAL_REVIEW_FLAG_PATH);
  try {
    if (!existsSync(abs)) return true;
    const json = JSON.parse(readFileSync(abs, 'utf8'));
    const flag = json?.legal?.reviewPending;
    return typeof flag === 'boolean' ? flag : true;
  } catch {
    return true;
  }
}

/** Scan a repo root for draft markers and the pending flag. Returns hits. */
export function checkLegalGate(root = ROOT) {
  const hits = [];
  if (resolveLegalReviewPending(root)) {
    hits.push(
      `${LEGAL_REVIEW_FLAG_PATH}: legal.reviewPending is true ` +
        `(LEGAL_REVIEW_PENDING — flip to false only after lawyer sign-off)`,
    );
  }
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
    console.error('deploys are blocked until LEGAL_REVIEW_PENDING is cleared:');
    console.error('set legal.reviewPending to false in app-config.json (and');
    console.error('the compiled default) and remove every');
    console.error('`draft-pending-lawyer` marker.');
    console.error('');
    console.error('What Karan needs to do:');
    console.error('  1. Have counsel review docs/legal/approved-copy.md and');
    console.error('     the privacy/terms pages + PIPEDA copy.');
    console.error('  2. Replace the draft text with the approved wording.');
    console.error('  3. Flip legal.reviewPending to false; remove every');
    console.error('     `draft-pending-lawyer` marker.');
    console.error('');
    console.error('Gate hits:');
    for (const h of hits) console.error(`  - ${h}`);
    console.error('');
    process.exit(1);
  }
  console.log('Legal gate: LEGAL_REVIEW_PENDING cleared, no draft markers. OK.');
}
