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

const prs = ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,author,isDraft,labels,mergeStateStatus,reviews,headRefOid,headRefName,comments']) ?? [];
const once = (p, key) => !(p.comments ?? []).some((c) => (c.body ?? '').includes(`<!-- agent:${key}:${p.headRefOid} -->`));
const mark = (p, key, text) => ghWrite(['pr', 'comment', String(p.number), '--body', `<!-- agent:${key}:${p.headRefOid} -->\n${text}`]);
// I: CI runs on agent pushes that GitHub holds for human approval (oversight gate) — surface once.
const waiting = ghJson(['run', 'list', '--status', 'action_required', '--limit', '50', '--json', 'headBranch']) ?? [];
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
  const isAgent = pr.labels.includes('agent:pr');

  if (waiting.some((w) => w.headBranch === p.headRefName) && once(p, 'needs-run-approval')) {
    mark(p, 'needs-run-approval', 'CI runs for this PR are **waiting for owner approval** (Actions → the run → Approve and run). Agents cannot approve their own runs.');
  }
  // F: merge conflict on an agent PR → fix agent resolves it (once per head commit)
  if (isAgent && p.mergeStateStatus === 'DIRTY' && once(p, 'conflict')) {
    mark(p, 'conflict', 'Merge conflict with main — starting a fix round to merge main in and resolve.');
    ghWrite(['workflow', 'run', 'agent-fix.yml', '-f', `pr=${p.number}`, '-f', 'reason=merge conflict with main: merge main in, resolve, re-verify']);
  }
  // E: green but never reviewed (review run skipped/crashed) → run the reviewer (once per head commit)
  if (isAgent && d.action === 'skip' && d.reason === 'awaiting review' && once(p, 'review-requested')) {
    mark(p, 'review-requested', 'All checks green but no review verdict for this commit — starting the reviewer.');
    ghWrite(['workflow', 'run', 'agent-review.yml', '-f', `pr=${p.number}`]);
  }

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
  // B: a GITHUB_TOKEN merge fires no 'pull_request: closed' event, so wake the orchestrator ourselves.
  ghWrite(['workflow', 'run', 'agent-dispatch.yml', '--ref', 'main']);
  console.log('triggered CI + dev deploy on main');
}
