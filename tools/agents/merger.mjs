#!/usr/bin/env node
/**
 * Merger (no AI) — runs on GitHub every 10 minutes and when checks finish.
 * Owner rule (2026-11-13): merge only when EVERY check is green and the PR is
 * approved (agent PRs: reviewer verdict APPROVE / agent:approved; owner PRs by
 * authorship). Merges every eligible PR per run (main is not strict up-to-date),
 * never updates BEHIND branches (not required; a bot push holds CI for approval),
 * stops the line while the latest CI run on main is red (only owner PRs or PRs
 * labelled main-fix merge then), re-runs red environment checks (≤3 attempts), and after
 * merging triggers CI + the dev deploy on main (a GITHUB_TOKEN merge fires no
 * push workflows).
 *
 *   node tools/agents/merger.mjs [--dry-run]
 */
import { decideMerge, linkedIssues, fixRoundState } from './lib.mjs';
import { ghJson, ghWrite, dispatchFixRound, maxFixRounds, prComments } from './gh.mjs';

const prs = ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,author,isDraft,labels,mergeStateStatus,reviews,headRefOid,headRefName,comments,body']) ?? [];
const once = (p, key) => !(p.comments ?? []).some((c) => (c.body ?? '').includes(`<!-- agent:${key}:${p.headRefOid} -->`));
const mark = (p, key, text) => ghWrite(['pr', 'comment', String(p.number), '--body', `<!-- agent:${key}:${p.headRefOid} -->\n${text}`]);
// I: CI runs on agent pushes that GitHub holds for human approval (oversight gate) — surface once.
const waiting = ghJson(['run', 'list', '--status', 'action_required', '--limit', '50', '--json', 'headBranch']) ?? [];
prs.sort((a, b) => a.number - b.number); // oldest first
let merged = 0;
// Stop the line: parallel merges on top of a red main compound the breakage.
const lastMainCi = (ghJson(['run', 'list', '--workflow', 'ci.yml', '--branch', 'main', '--status', 'completed', '--limit', '1', '--json', 'conclusion,headSha']) ?? [])[0];
const mainRed = lastMainCi?.conclusion === 'failure';
if (mainRed) console.log(`main CI is red @ ${lastMainCi.headSha.slice(0, 7)} — merging only owner / main-fix PRs`);

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
  // A PR parked at the fix-round cap gets no further rounds (#924) — and no conflict marker either.
  // Cap state needs prComments (all comments, bot authors identifiable) — not p.comments.
  if (isAgent && p.mergeStateStatus === 'DIRTY' && once(p, 'conflict')) {
    const comments = prComments(p.number);
    if (!fixRoundState(comments, maxFixRounds()).atCap) {
      mark(p, 'conflict', 'Merge conflict with main — starting a fix round to merge main in and resolve.');
      dispatchFixRound(p.number, 'merge conflict with main: merge main in, resolve, re-verify', comments);
    }
  }
  // E: green but never reviewed (review run skipped/crashed) → run the reviewer (once per head commit)
  if (isAgent && d.action === 'skip' && d.reason === 'awaiting review' && once(p, 'review-requested')) {
    mark(p, 'review-requested', 'All checks green but no review verdict for this commit — starting the reviewer.');
    ghWrite(['workflow', 'run', 'agent-review.yml', '-f', `pr=${p.number}`]);
  }

  if (d.action === 'merge' && mainRed && author !== 'ksingh31' && !pr.labels.includes('main-fix')) {
    console.log(`  #${p.number} held: main is red`);
  } else if (d.action === 'merge') {
    // main no longer requires branches to be up to date (owner, 2026-11-15), so merge
    // every eligible PR in one pass. A PR that conflicts after an earlier merge fails
    // here and gets a fix round on the next run (DIRTY → agent-fix).
    try {
      ghWrite(['pr', 'merge', String(p.number), '--squash', '--delete-branch']);
      merged += 1;
      // A GITHUB_TOKEN merge does not fire the auto-close for "Fixes #n", so stale
      // agent:claimed issues pile up and eat dispatcher WIP slots. Close them here.
      for (const n of linkedIssues(p.body)) {
        try {
          ghWrite(['issue', 'close', String(n), '--comment', `Done in #${p.number} (merged).`]);
          ghWrite(['issue', 'edit', String(n), '--remove-label', 'agent:claimed']);
        } catch (err) {
          console.log(`  could not close #${n}: ${String(err.message).split('\n')[0]}`);
        }
      }
    } catch (err) {
      console.log(`  #${p.number} merge failed: ${String(err.message).split('\n')[0]}`);
    }
  } else if (d.action === 'update') {
    console.log(`  #${p.number} is behind main — not required (strict off), leaving as is`);
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
  ghWrite(['workflow', 'run', 'swa-preview-janitor.yml', '--ref', 'main']); // merged PR's preview
  console.log('triggered CI + dev deploy on main');
}
