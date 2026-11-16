#!/usr/bin/env node
/**
 * Fix-round cap (#924) — one implementation for every place that starts or runs
 * an agent-fix round, so a PR at the cap is parked exactly once and then left alone.
 *
 *   gate <pr> --reason <r>      agent-fix.yml "Round cap" step. Posts the fix-round
 *                               comment and prints go=true, or — at the cap — posts the
 *                               parked comment once (<!-- agent:fix-cap -->), labels
 *                               agent:stuck, prints go=false. Later calls print go=false
 *                               without commenting or relabelling. Writes go= (and
 *                               branch= when go) to $GITHUB_OUTPUT when set.
 *   dispatch <pr> --reason <r>  Start agent-fix.yml unless the PR is parked
 *                               (agent-review-followup.yml).
 *
 * Merge-conflict rounds (reason starts with "merge conflict with main") are numbered
 * on their own counter and never count toward AGENT_MAX_FIX_ROUNDS (default 5).
 *
 *   node tools/agents/fix-round.mjs <gate|dispatch> <pr> --reason "<reason>" [--dry-run]
 */
import { appendFileSync } from 'node:fs';
import { LABELS, MARKERS, planFixRound } from './lib.mjs';
import { ghJson, ghWrite, prComments, maxFixRounds, dispatchFixRound } from './gh.mjs';

const argv = process.argv.slice(2);
const reasonIdx = argv.indexOf('--reason');
const reason = reasonIdx > -1 ? (argv[reasonIdx + 1] ?? '') : 'review requested changes';
const [mode, pr] = argv.filter((a, i) => !a.startsWith('--') && i !== reasonIdx + 1);
if (!['gate', 'dispatch'].includes(mode) || !/^\d+$/.test(pr ?? '')) {
  console.error('usage: fix-round.mjs <gate|dispatch> <pr> --reason "<reason>" [--dry-run]');
  process.exit(2);
}

const output = (pairs) => {
  for (const [k, v] of Object.entries(pairs)) {
    console.log(`${k}=${v}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  }
};

if (mode === 'dispatch') {
  dispatchFixRound(pr, reason);
} else {
  const max = maxFixRounds();
  const plan = planFixRound({ comments: prComments(pr), reason, max });
  console.log(JSON.stringify({ pr: Number(pr), action: plan.action, rounds: plan.state.rounds, conflictRounds: plan.state.conflictRounds, max }));
  if (plan.action === 'start') {
    const head = plan.conflict ? `Fix round ${plan.round} (merge main — not counted toward the ${max}-round cap)` : `Fix round ${plan.round}/${max}`;
    ghWrite(['pr', 'comment', pr, '--body', `${MARKERS.fixRound}\n${head}: ${reason}`]);
    const branch = ghJson(['pr', 'view', pr, '--json', 'headRefName'])?.headRefName ?? '';
    output({ go: 'true', branch });
  } else {
    if (plan.action === 'park') {
      // Escalation policy (2026-11-15): repeated failures are the orchestrator's, not an owner decision.
      // needs:karan is neither added nor removed here.
      ghWrite(['pr', 'edit', pr, '--add-label', LABELS.stuck]);
      ghWrite(['pr', 'comment', pr, '--body', `${MARKERS.fixCap}\nFix-round cap (${max}) reached — parked as \`${LABELS.stuck}\` for the orchestrator. No further fix rounds start for this PR.`]);
    }
    output({ go: 'false' });
  }
}
