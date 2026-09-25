#!/usr/bin/env node
/**
 * CASL copy diff test (HRD-05, acceptance criterion 2).
 *
 * Byte-matches the lead-gate CASL opt-in wording in the app
 * (`caslLabel` in apps/web/src/app/core/config/app-config.defaults.ts)
 * against the approved wording in docs/legal/approved-copy.md
 * (the ```text block under "### CASL consent wording").
 *
 * Why byte-match: CASL consent must use the exact lawyer-approved wording —
 * even a one-word drift is a compliance risk. The approved file currently
 * carries the draft wording (marked draft-pending-lawyer); when counsel
 * approves or rewrites it, they update the block in approved-copy.md and
 * this check forces the app to follow.
 *
 * Proven to bite by apps/web/tools/check-casl-copy.spec.ts (vitest).
 *
 * Usage: node apps/web/tools/check-casl-copy.mjs (paths resolve from the
 * script location, so any cwd works).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS_DIR, '..', '..', '..'); // repo root

/** Extract the caslLabel string literal from app-config.defaults.ts. */
export function extractAppWording(root = ROOT) {
  const p = join(
    root,
    'apps',
    'web',
    'src',
    'app',
    'core',
    'config',
    'app-config.defaults.ts',
  );
  const src = readFileSync(p, 'utf8');
  const m = src.match(/caslLabel:\s*\n?\s*'([^']*)'/);
  if (!m) throw new Error(`caslLabel not found in ${p}`);
  return m[1];
}

/** Extract the ```text block under "### CASL consent wording". */
export function extractApprovedWording(root = ROOT) {
  const p = join(root, 'docs', 'legal', 'approved-copy.md');
  const md = readFileSync(p, 'utf8');
  const sectionIdx = md.indexOf('### CASL consent wording');
  if (sectionIdx === -1)
    throw new Error(`"### CASL consent wording" not found in ${p}`);
  const after = md.slice(sectionIdx);
  const m = after.match(/```text\n([\s\S]*?)\n```/);
  if (!m)
    throw new Error(`No \`\`\`text block under "### CASL consent wording" in ${p}`);
  return m[1];
}

/** Returns null when the wordings match, else a description of the drift. */
export function checkCaslCopy(root = ROOT) {
  const appWording = extractAppWording(root);
  const approvedWording = extractApprovedWording(root);
  if (appWording === approvedWording) return null;
  return {
    approvedWording,
    appWording,
  };
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const drift = checkCaslCopy();
  if (drift) {
    console.error('');
    console.error('CASL DIFF TEST FAILED — gate wording drifted from approved copy.');
    console.error('');
    console.error('Approved (docs/legal/approved-copy.md):');
    console.error(`  ${JSON.stringify(drift.approvedWording)}`);
    console.error('App (app-config.defaults.ts caslLabel):');
    console.error(`  ${JSON.stringify(drift.appWording)}`);
    console.error('');
    console.error(
      'Fix: update the wording in ONE place (docs/legal/approved-copy.md is the',
    );
    console.error(
      'source of truth once the lawyer approves it) and sync the other.',
    );
    console.error('');
    process.exit(1);
  }
  console.log('CASL diff test: gate wording byte-matches approved copy. OK.');
}
