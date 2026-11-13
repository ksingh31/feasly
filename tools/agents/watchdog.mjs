#!/usr/bin/env node
/**
 * Watchdog: finds stalled agent work and moves it (requeue / re-review /
 * fix round / escalate to needs:karan). Never merges, closes, or deletes.
 * Writes a JSON summary (default watchdog-summary.json) that the architect
 * agent turns into the daily digest.
 *
 *   node tools/agents/watchdog.mjs [--dry-run] [--out <file>]
 */
import { writeFileSync } from 'node:fs';
import { LABELS, MARKERS, DEFAULTS, judgeClaimedIssue, judgeAgentPr, branchPrefixFor } from './lib.mjs';
import { ghWrite, intVar, listIssues, listAgentPrs, labeledAt, issueComments, prChecks } from './gh.mjs';

const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > -1 ? process.argv[outIdx + 1] : 'watchdog-summary.json';
const cfg = {
  ...DEFAULTS,
  claimStallHours: intVar('AGENT_CLAIM_STALL_HOURS', DEFAULTS.claimStallHours),
  prStaleHours: intVar('AGENT_PR_STALE_HOURS', DEFAULTS.prStaleHours),
  ciRedHours: intVar('AGENT_CI_RED_HOURS', DEFAULTS.ciRedHours),
};
const now = Date.now();
const summary = { generatedAt: new Date(now).toISOString(), issues: [], prs: [], ready: 0, needsKaran: [] };

const prs = listAgentPrs();
for (const issue of listIssues(LABELS.claimed)) {
  const linkedPr = prs.find((p) => p.headRefName.startsWith(branchPrefixFor(issue.number))) ?? null;
  const claimedAt = labeledAt(issue.number, LABELS.claimed) ?? issue.createdAt;
  const comments = issueComments(issue.number);
  const verdict = judgeClaimedIssue({ issue, claimedAt, linkedPr, comments, now, cfg });
  summary.issues.push({ number: issue.number, title: issue.title, claimedAt, pr: linkedPr?.number ?? null, ...verdict });

  if (verdict.action === 'requeue') {
    ghWrite(['issue', 'edit', String(issue.number), '--remove-label', LABELS.claimed, '--add-label', LABELS.ready]);
    ghWrite(['issue', 'comment', String(issue.number), '--body', `${MARKERS.requeue}\nWatchdog: ${verdict.reason} — requeued.`]);
  } else if (verdict.action === 'escalate') {
    ghWrite(['issue', 'edit', String(issue.number), '--remove-label', LABELS.claimed, '--add-label', LABELS.needsKaran]);
    ghWrite(['issue', 'comment', String(issue.number), '--body', `Watchdog: ${verdict.reason}. Parked for Karan.`]);
  } else if (verdict.action === 'overdue') {
    ghWrite(['issue', 'comment', String(issue.number), '--body', `${MARKERS.overdue}\nWatchdog: ${verdict.reason}. The architect will look at splitting or re-planning it in the next digest.`]);
  }
}

for (const pr of prs) {
  const checks = prChecks(pr.number);
  const verdict = judgeAgentPr({ pr: { ...pr, checks }, now, cfg });
  summary.prs.push({ number: pr.number, title: pr.title, updatedAt: pr.updatedAt, reviewDecision: pr.reviewDecision, ...verdict });
  if (verdict.action === 'rereview') {
    ghWrite(['workflow', 'run', 'agent-review.yml', '-f', `pr=${pr.number}`]);
  } else if (verdict.action === 'fix') {
    ghWrite(['workflow', 'run', 'agent-fix.yml', '-f', `pr=${pr.number}`, '-f', `reason=${verdict.reason}`]);
  }
}

summary.ready = listIssues(LABELS.ready).length;
summary.needsKaran = listIssues(LABELS.needsKaran).map((i) => ({ number: i.number, title: i.title, url: i.url }));
writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ issues: summary.issues.length, prs: summary.prs.length, ready: summary.ready, needsKaran: summary.needsKaran.length }));
