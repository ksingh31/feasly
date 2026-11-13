#!/usr/bin/env node
/**
 * Merge gate (deterministic — the model only supplies the verdict).
 *   APPROVE + no sensitive paths + no needs:karan → label agent:approved.
 *     Owner rule (2026-11-13): merge only when EVERY check is green (not just
 *     the required ones GitHub auto-merge waits for) — the release manager
 *     merges approved PRs once all checks pass, re-running flaky env checks.
 *   APPROVE + sensitive paths → label needs:karan, do not enable.
 *   REQUEST_CHANGES on an agent PR → agent-fix.yml picks it up (round cap there).
 *   NEEDS_KARAN → label needs:karan.
 *
 *   node tools/agents/merge-gate.mjs <pr> <APPROVE|REQUEST_CHANGES|NEEDS_KARAN> [--dry-run]
 */
import { LABELS, sensitiveFiles } from './lib.mjs';
import { ghJson, ghWrite } from './gh.mjs';

const [pr, verdict] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!pr || !verdict) {
  console.error('usage: merge-gate.mjs <pr> <verdict> [--dry-run]');
  process.exit(2);
}

const info = ghJson(['pr', 'view', pr, '--json', 'files,labels,author,isDraft,state']);
const labels = info.labels.map((l) => l.name);
const isAgentPr = labels.includes(LABELS.pr);

if (info.state !== 'OPEN' || info.isDraft) {
  console.log(`#${pr}: ${info.state}${info.isDraft ? ' (draft)' : ''} — nothing to do`);
} else if (verdict === 'NEEDS_KARAN' || labels.includes(LABELS.needsKaran)) {
  ghWrite(['pr', 'edit', pr, '--add-label', LABELS.needsKaran]);
  console.log(`#${pr}: parked for Karan`);
} else if (verdict === 'APPROVE') {
  const sensitive = sensitiveFiles(info.files.map((f) => f.path));
  if (sensitive.length > 0) {
    ghWrite(['pr', 'edit', pr, '--add-label', LABELS.needsKaran]);
    ghWrite([
      'pr', 'comment', pr, '--body',
      `Reviewer approved, but this touches owner-gated paths, so auto-merge is held:\n${sensitive.map((p) => `- \`${p}\``).join('\n')}\n\nMerge manually (or remove \`needs:karan\` and re-run Agent · Review) once you're happy.`,
    ]);
    console.log(`#${pr}: approved but sensitive → held`);
  } else {
    ghWrite(['pr', 'edit', pr, '--add-label', 'agent:approved']);
    console.log(`#${pr}: approved — merges once every check is green`);
  }
} else if (verdict === 'REQUEST_CHANGES') {
  if (isAgentPr) ghWrite(['workflow', 'run', 'agent-fix.yml', '-f', `pr=${pr}`, '-f', 'reason=review requested changes']);
  console.log(`#${pr}: changes requested${isAgentPr ? ' → fix round dispatched' : ' (human PR — author fixes)'}`);
}
