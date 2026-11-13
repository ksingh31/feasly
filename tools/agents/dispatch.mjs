#!/usr/bin/env node
/**
 * Dispatcher: hands `agent:ready` issues to dev agents, up to AGENT_MAX_WIP
 * in flight. Plain script, no AI. Triggered by agent-dispatch.yml on label /
 * PR-closed events and hourly as a backstop.
 *
 *   node tools/agents/dispatch.mjs [--dry-run]
 */
import { LABELS, MARKERS, DEFAULTS, planDispatch, areaOf, shouldReleaseBacklog } from './lib.mjs';
import { ghWrite, intVar, listIssues, listAgentPrs, openIssueNumbers } from './gh.mjs';

const maxWip = intVar('AGENT_MAX_WIP', DEFAULTS.maxWip);

// Release approved stories once the bug queue is clear (owner rule).
const backlog = listIssues('backlog');
const gate = shouldReleaseBacklog({ openBugs: listIssues(LABELS.bug), backlogCount: backlog.length });
if (gate.release) {
  console.log(`bug queue clear — releasing ${backlog.length} backlog stories to agents`);
  for (const i of backlog) ghWrite(['issue', 'edit', String(i.number), '--remove-label', 'backlog', '--add-label', LABELS.ready]);
} else if (backlog.length) {
  console.log(`backlog held (${backlog.length} stories) until bugs close: #${gate.blockingBugs.join(', #')}`);
}

const readyIssues = listIssues(LABELS.ready);
const claimed = listIssues(LABELS.claimed);
const openPrs = listAgentPrs();

const { start, skipped } = planDispatch({
  readyIssues,
  claimedCount: claimed.length,
  openAgentPrCount: openPrs.length,
  maxWip,
  openIssueNumbers: openIssueNumbers(),
});

console.log(
  `ready=${readyIssues.length} claimed=${claimed.length} agentPRs=${openPrs.length} maxWip=${maxWip} → starting ${start.length}`,
);
for (const s of skipped) console.log(`skip #${s.number}: ${s.reason}`);

for (const issue of start) {
  const area = areaOf(issue);
  ghWrite(['issue', 'edit', String(issue.number), '--add-label', LABELS.claimed, '--remove-label', LABELS.ready]);
  ghWrite([
    'issue', 'comment', String(issue.number),
    '--body', `${MARKERS.claim}\nClaimed by the **${area}** dev agent. Progress shows on the PR (branch \`agent/issue-${issue.number}-…\`).`,
  ]);
  ghWrite(['workflow', 'run', 'agent-dev.yml', '-f', `issue=${issue.number}`, '-f', `area=${area}`]);
  console.log(`started #${issue.number} (${area})`);
}
