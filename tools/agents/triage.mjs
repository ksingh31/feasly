#!/usr/bin/env node
/**
 * CI triage (no AI): reacts to a failed CI / Lighthouse run.
 *   PR, env-only failures      → nothing (tracked on main as ops issues)
 *   PR behind main             → update branch (Dependabot: "@dependabot rebase")
 *   agent / Dependabot PR      → dispatch agent-fix.yml
 *   human PR                   → comment listing the failing checks
 *   main                       → open/update the single "main is red" issue
 *                                (bug + priority:high + agent:ready, or ops +
 *                                needs:karan when only env checks failed)
 *
 *   node tools/agents/triage.mjs <run-id> [--dry-run]
 */
import { LABELS, triageFailure } from './lib.mjs';
import { ghJson, ghWrite, listIssues } from './gh.mjs';

const runId = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!runId) {
  console.error('usage: triage.mjs <run-id> [--dry-run]');
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY ?? ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
const run = ghJson(['run', 'view', runId, '--json', 'headBranch,headSha,event,url,workflowName,jobs']);
const failedJobs = run.jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name);
if (failedJobs.length === 0) {
  console.log('no failed jobs');
  process.exit(0);
}

let pr = null;
if (run.headBranch !== 'main') {
  const found = ghJson(['pr', 'list', '--state', 'open', '--head', run.headBranch, '--json', 'number,author,labels,headRefOid']) ?? [];
  if (found.length === 0) {
    console.log(`no open PR for ${run.headBranch}`);
    process.exit(0);
  }
  const p = found[0];
  if (p.headRefOid !== run.headSha) {
    console.log(`run is for an old head of #${p.number} — skipping`);
    process.exit(0);
  }
  const cmp = ghJson(['api', `repos/${repo}/compare/main...${encodeURIComponent(run.headBranch)}`]);
  pr = {
    number: p.number,
    // gh reports bots as "app/dependabot" (is_bot) — normalise to "dependabot[bot]".
    author: p.author?.is_bot ? `${p.author.login.replace(/^app\//, '').replace(/\[bot\]$/, '')}[bot]` : p.author?.login,
    labels: p.labels.map((l) => l.name),
    behindBy: cmp?.behind_by ?? 0,
  };
}

const verdict = triageFailure({ failedJobs, pr });
console.log(JSON.stringify({ run: runId, branch: run.headBranch, failedJobs, pr: pr?.number ?? null, ...verdict }));
const list = (jobs) => jobs.map((j) => `\`${j}\``).join(', ');

switch (verdict.action) {
  case 'rebase-dependabot':
    ghWrite(['pr', 'comment', String(pr.number), '--body', '@dependabot rebase']);
    break;
  case 'update-branch':
    ghWrite(['pr', 'update-branch', String(pr.number)]);
    break;
  case 'fix':
    ghWrite(['workflow', 'run', 'agent-fix.yml', '-f', `pr=${pr.number}`, '-f', `reason=CI failed: ${verdict.codeJobs.join(', ')}`]);
    break;
  case 'comment':
    ghWrite(['pr', 'comment', String(pr.number), '--body', `CI failed (${run.workflowName}): ${list(verdict.codeJobs)} — ${run.url}`]);
    break;
  case 'main-issue': {
    const title = 'main is red';
    const existing = [...listIssues(LABELS.bug), ...listIssues('ops')].find((i) => i.title === title);
    const codeOnly = verdict.codeJobs.length > 0;
    const body =
      `CI on \`main\` failed at ${run.headSha.slice(0, 7)} (${run.workflowName}): ${run.url}\n\n` +
      (codeOnly ? `Code checks: ${list(verdict.codeJobs)}\n` : '') +
      (verdict.envJobs.length ? `Environment checks (live Azure state, not code): ${list(verdict.envJobs)}\n` : '') +
      `\nAcceptance criteria: the failing checks pass on main; root cause explained in the PR.`;
    if (existing) {
      ghWrite(['issue', 'comment', String(existing.number), '--body', body]);
    } else {
      const labels = codeOnly
        ? [LABELS.bug, LABELS.priorityHigh, LABELS.ready, LABELS.areaWeb, 'size:S']
        : ['ops', LABELS.needsKaran];
      ghWrite(['issue', 'create', '--title', title, '--body', body, ...labels.flatMap((l) => ['--label', l])]);
    }
    break;
  }
  default:
    break;
}
