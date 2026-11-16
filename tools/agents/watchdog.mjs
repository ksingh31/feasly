#!/usr/bin/env node
/**
 * Watchdog: finds stalled agent work and moves it (requeue / re-review /
 * fix round / park as agent:stuck). PRs parked at the fix-round cap are listed
 * separately (`summary.parked`) and get no further rounds (#924). Never merges or deletes; the only thing it
 * closes is a claimed issue whose PR has already merged (close as completed
 * instead of requeueing finished work — #635).
 * Writes a JSON summary (default watchdog-summary.json) that the architect
 * agent turns into the daily digest.
 *
 *   node tools/agents/watchdog.mjs [--dry-run] [--out <file>]
 */
import { writeFileSync } from 'node:fs';
import { LABELS, MARKERS, DEFAULTS, judgeClaimedIssue, judgeAgentPr, branchPrefixFor, findMergedPrFor, fixRoundState } from './lib.mjs';
import { ghWrite, intVar, listIssues, listAgentPrs, listMergedPrs, labeledAt, issueComments, prChecks, maxFixRounds } from './gh.mjs';

const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > -1 ? process.argv[outIdx + 1] : 'watchdog-summary.json';
const cfg = {
  ...DEFAULTS,
  claimStallHours: intVar('AGENT_CLAIM_STALL_HOURS', DEFAULTS.claimStallHours),
  prStaleHours: intVar('AGENT_PR_STALE_HOURS', DEFAULTS.prStaleHours),
  ciRedHours: intVar('AGENT_CI_RED_HOURS', DEFAULTS.ciRedHours),
};
const now = Date.now();
const summary = { generatedAt: new Date(now).toISOString(), issues: [], prs: [], parked: [], ready: 0, needsKaran: [] };

const prs = listAgentPrs();
const maxRounds = maxFixRounds();
const fixRoundsOf = new Map(prs.map((p) => [p.number, fixRoundState(p.comments, maxRounds)]));
let mergedPrs = null; // fetched lazily: only needed when a claimed issue has no open PR
for (const issue of listIssues(LABELS.claimed)) {
  const linkedPr = prs.find((p) => p.headRefName.startsWith(branchPrefixFor(issue.number))) ?? null;
  const claimedAt = labeledAt(issue.number, LABELS.claimed) ?? issue.createdAt;
  let mergedPr = null;
  if (!linkedPr) {
    mergedPrs ??= listMergedPrs();
    mergedPr = findMergedPrFor(issue.number, mergedPrs, claimedAt);
  }
  const comments = issueComments(issue.number);
  const linkedPrParked = linkedPr ? fixRoundsOf.get(linkedPr.number)?.atCap === true : false;
  const verdict = judgeClaimedIssue({ issue, claimedAt, linkedPr, mergedPr, linkedPrParked, comments, now, cfg });
  summary.issues.push({ number: issue.number, title: issue.title, claimedAt, pr: linkedPr?.number ?? mergedPr?.number ?? null, ...verdict });

  if (verdict.action === 'close') {
    ghWrite(['issue', 'edit', String(issue.number), '--remove-label', LABELS.claimed]);
    ghWrite(['issue', 'close', String(issue.number), '--reason', 'completed', '--comment', `Watchdog: ${verdict.reason} (${mergedPr.url ?? `#${mergedPr.number}`}) — closing as completed instead of requeueing.`]);
  } else if (verdict.action === 'requeue') {
    ghWrite(['issue', 'edit', String(issue.number), '--remove-label', LABELS.claimed, '--add-label', LABELS.ready]);
    ghWrite(['issue', 'comment', String(issue.number), '--body', `${MARKERS.requeue}\nWatchdog: ${verdict.reason} — requeued.`]);
  } else if (verdict.action === 'escalate') {
    ghWrite(['issue', 'edit', String(issue.number), '--remove-label', LABELS.claimed, '--add-label', 'agent:stuck']);
    // Escalation policy: repeated agent failures are the orchestrator's to fix, not an owner decision.
    ghWrite(['issue', 'comment', String(issue.number), '--body', `Watchdog: ${verdict.reason}. Parked as agent:stuck for the orchestrator.`]);
  } else if (verdict.action === 'overdue') {
    ghWrite(['issue', 'comment', String(issue.number), '--body', `${MARKERS.overdue}\nWatchdog: ${verdict.reason}. The architect will look at splitting or re-planning it in the next digest.`]);
  }
}

for (const pr of prs) {
  const fixRounds = fixRoundsOf.get(pr.number);
  if (fixRounds.atCap) {
    // Parked: bot comments keep bumping updatedAt, so judge by the cap, not activity (#924).
    // Listed separately so the digest shows them as stalled. Label for the orchestrator
    // queue once; a needs:karan already on the PR (real owner question) is left alone.
    const labels = (pr.labels ?? []).map((l) => l.name);
    summary.parked.push({ number: pr.number, title: pr.title, url: pr.url, rounds: fixRounds.rounds, conflictRounds: fixRounds.conflictRounds, max: fixRounds.max, labels });
    if (!labels.includes(LABELS.stuck)) ghWrite(['pr', 'edit', String(pr.number), '--add-label', LABELS.stuck]);
  }
  const checks = fixRounds.atCap ? [] : prChecks(pr.number);
  const verdict = judgeAgentPr({ pr: { ...pr, checks }, now, cfg, fixRounds });
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
console.log(JSON.stringify({ issues: summary.issues.length, prs: summary.prs.length, parked: summary.parked.length, ready: summary.ready, needsKaran: summary.needsKaran.length }));
