#!/usr/bin/env node
/**
 * Merger (no AI) — runs on GitHub every 10 minutes and when checks finish.
 * Owner rule (2026-11-13): merge only when EVERY check is green and the PR is
 * approved (agent PRs: reviewer verdict APPROVE / agent:approved; owner PRs by
 * authorship). Updates at most one stale branch per run (each merge makes the
 * others stale again), re-runs red environment checks (≤3 attempts), and after
 * merging triggers CI + the dev deploy on main (a GITHUB_TOKEN merge fires no
 * push workflows).
 *
 *   node tools/agents/merger.mjs [--dry-run]
 */
import { decideMerge } from './lib.mjs';
import { ghJson, ghWrite } from './gh.mjs';

const prs = ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,author,isDraft,labels,mergeStateStatus,reviews,headRefOid']) ?? [];
prs.sort((a, b) => a.number - b.number); // oldest first
let merged = 0;
let updated = false;

for (const p of prs) {
  let checks = [];
  try {
    checks = ghJson(['pr', 'checks', String(p.number), '--json', 'name,bucket,link']) ?? [];
  } catch (e) {
    // gh exits non-zero when checks fail but still prints JSON
    try { checks = JSON.parse(e.stdout?.toString() || '[]'); } catch { checks = []; }
  }
  const author = p.author?.is_bot ? `${p.author.login.replace(/^app\//, '').replace(/\[bot\]$/, '')}[bot]` : p.author?.login;
  const verdicts = (p.reviews ?? [])
    .map((r) => /Verdict:\s*(APPROVE|REQUEST_CHANGES|NEEDS_KARAN)/.exec(r.body ?? '')?.[1])
    .filter(Boolean);
  const pr = {
    author, isDraft: p.isDraft, labels: p.labels.map((l) => l.name),
    verdict: verdicts.at(-1) ?? '', mergeState: p.mergeStateStatus, checks,
  };
  const d = decideMerge(pr);
  console.log(`#${p.number}: ${d.action} — ${d.reason}`);

  if (d.action === 'merge') {
    ghWrite(['pr', 'merge', String(p.number), '--squash', '--delete-branch']);
    merged += 1;
    break; // main moved: everything else is behind now; next run continues
  } else if (d.action === 'update' && !updated) {
    ghWrite(['pr', 'update-branch', String(p.number)]);
    updated = true;
  } else if (d.action === 'rerun') {
    const runs = [...new Set(checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
      .map((c) => /\/runs\/(\d+)/.exec(c.link ?? '')?.[1]).filter(Boolean))];
    for (const id of runs) {
      const attempt = ghJson(['api', `repos/{owner}/{repo}/actions/runs/${id}`, '--jq', '{a: .run_attempt}'])?.a ?? 1;
      if (attempt < 3) ghWrite(['run', 'rerun', id, '--failed']);
      else console.log(`  run ${id} already attempted ${attempt}x — leaving for the watchdog/triage`);
    }
  }
}

if (merged > 0) {
  ghWrite(['workflow', 'run', 'ci.yml', '--ref', 'main']);
  ghWrite(['workflow', 'run', 'cd.yml', '--ref', 'main', '-f', 'target=dev']);
  console.log('triggered CI + dev deploy on main');
}
