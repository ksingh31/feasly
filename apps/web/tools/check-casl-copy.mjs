#!/usr/bin/env node
/**
 * CASL copy diff test (HRD-05, acceptance criterion 2).
 *
 * Byte-matches the lead-gate contact-consent wording in the app
 * (`consentLabel` in apps/web/src/app/core/config/app-config.defaults.ts)
 * against the approved wording in docs/legal/approved-copy.md
 * (the ```text block under "### CASL consent wording").
 *
 * Why byte-match: CASL consent must use the exact lawyer-approved wording —
 * even a one-word drift is a compliance risk. The approved file currently
 * carries the draft wording (marked draft-pending-lawyer); when counsel
 * approves or rewrites it, they update the block in approved-copy.md and
 * this check forces the app to follow.
 *
 * #520 (owner decision 2026-11-15): the waitlist consent checkbox is held to
 * the same rule — `copy.waitlist.consentLabel` byte-matches the ```text
 * block under "### CASL waitlist consent wording".
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

/** Extract the consentLabel string literal from app-config.defaults.ts. */
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
  const m = src.match(/consentLabel:\s*\n?\s*'([^']*)'/);
  if (!m) throw new Error(`consentLabel not found in ${p}`);
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

/** Extract `consentLabel` inside the `waitlist: {` copy block. */
export function extractWaitlistAppWording(root = ROOT) {
  const p = join(root, 'apps', 'web', 'src', 'app', 'core', 'config', 'app-config.defaults.ts');
  const src = readFileSync(p, 'utf8');
  const blockIdx = src.indexOf('waitlist: {');
  if (blockIdx === -1) throw new Error(`waitlist copy block not found in ${p}`);
  const m = src.slice(blockIdx).match(/consentLabel:\s*\n?\s*'([^']*)'/);
  if (!m) throw new Error(`waitlist consentLabel not found in ${p}`);
  return m[1];
}

/** Extract the ```text block under "### CASL waitlist consent wording". */
export function extractWaitlistApprovedWording(root = ROOT) {
  const heading = '### CASL waitlist consent wording';
  const p = join(root, 'docs', 'legal', 'approved-copy.md');
  const md = readFileSync(p, 'utf8');
  const sectionIdx = md.indexOf(heading);
  if (sectionIdx === -1) throw new Error(`"${heading}" not found in ${p}`);
  const m = md.slice(sectionIdx).match(/```text\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`No \`\`\`text block under "${heading}" in ${p}`);
  return m[1];
}

/** Waitlist twin of checkCaslCopy: null when they match, else the drift. */
export function checkWaitlistCaslCopy(root = ROOT) {
  const appWording = extractWaitlistAppWording(root);
  const approvedWording = extractWaitlistApprovedWording(root);
  if (appWording === approvedWording) return null;
  return { approvedWording, appWording };
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
    console.error('App (app-config.defaults.ts consentLabel):');
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
  const waitlistDrift = checkWaitlistCaslCopy();
  if (waitlistDrift) {
    console.error('');
    console.error('CASL DIFF TEST FAILED — waitlist consent wording drifted from approved copy.');
    console.error('');
    console.error('Approved (docs/legal/approved-copy.md, "CASL waitlist consent wording"):');
    console.error(`  ${JSON.stringify(waitlistDrift.approvedWording)}`);
    console.error('App (app-config.defaults.ts copy.waitlist.consentLabel):');
    console.error(`  ${JSON.stringify(waitlistDrift.appWording)}`);
    console.error('');
    process.exit(1);
  }
  console.log('CASL diff test: waitlist wording byte-matches approved copy. OK.');
}
