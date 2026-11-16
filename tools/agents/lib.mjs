/**
 * Pure decision logic for the agent pipeline (dispatcher + watchdog).
 * No I/O here — everything is unit-tested in lib.test.mjs. The CLIs in this
 * folder fetch GitHub state with `gh`, call these functions, and act.
 *
 * Runbook: docs/agents.md.
 */

export const LABELS = {
  ready: 'agent:ready',
  claimed: 'agent:claimed',
  pr: 'agent:pr',
  needsKaran: 'needs:karan',
  stuck: 'agent:stuck',
  areaWeb: 'area:web',
  areaApi: 'area:api',
  areaInfra: 'area:infra',
  bug: 'bug',
  priorityHigh: 'priority:high',
};

/** Expected working days per size label; unsized stories default to M. */
export const SIZE_DAYS = { 'size:S': 1, 'size:M': 3, 'size:L': 5 };

/** Thresholds (hours) — overridable from repo variables via the CLIs. */
export const DEFAULTS = {
  maxWip: 2,
  claimStallHours: 4,
  prStaleHours: 24,
  ciRedHours: 12,
  maxRequeues: 2,
  maxOpenPrs: 8,
  maxFixRounds: 5,
};

/** Hidden comment markers so repeated runs stay idempotent. */
export const MARKERS = {
  requeue: '<!-- agent:requeue -->',
  overdue: '<!-- agent:overdue -->',
  claim: '<!-- agent:claim -->',
  fixRound: '<!-- agent:fix-round -->',
  fixCap: '<!-- agent:fix-cap -->',
  // Orchestrator releases a parked PR by commenting this: only rounds after it count.
  fixCapReset: '<!-- agent:fix-cap-reset -->',
};

/**
 * Fix rounds whose reason starts with this are "merge main in" rounds. A busy main
 * would otherwise burn the whole fix-round budget on merges (#904, #886, #924), so
 * they are counted separately and never toward the cap.
 */
export const CONFLICT_REASON = 'merge conflict with main';

/** Authors whose issues an agent may act on (issue body is the agent's prompt), and whose fix-round markers count. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_BOTS = new Set(['claude[bot]', 'github-actions[bot]', 'app/claude', 'app/github-actions']);

const names = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const has = (item, label) => names(item.labels).includes(label);

export function isTrustedAuthor(issue) {
  const login = issue.author?.login ?? '';
  // `gh issue list` reports bot authors either as "claude[bot]" or as
  // login "claude" with is_bot=true depending on version — accept both.
  const botLogin = issue.author?.is_bot === true ? `${login.replace(/\[bot\]$/, '')}[bot]` : login;
  return TRUSTED_ASSOCIATIONS.has(issue.authorAssociation) || TRUSTED_BOTS.has(login) || TRUSTED_BOTS.has(botLogin);
}

/** Which dev agent owns an issue. Infra goes to devops; default web. */
export function areaOf(issue) {
  if (has(issue, LABELS.areaApi)) return 'api';
  if (has(issue, LABELS.areaInfra)) return 'infra';
  return 'web';
}

/**
 * Explicit sequence from the issue body: a line `Order: N` (lower runs first).
 * Issues without one sort after every ordered issue.
 */
export function orderOf(issue) {
  const m = /^\s*Order:\s*(\d+)\s*$/im.exec(issue.body ?? '');
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** Issue numbers named on `Blocked by #a, #b` / `Depends on #a` lines. */
export function blockersOf(issue) {
  const out = new Set();
  for (const line of (issue.body ?? '').split('\n')) {
    if (/^\s*(blocked by|depends on)\b/i.test(line)) {
      for (const m of line.matchAll(/#(\d+)/g)) out.add(Number(m[1]));
    }
  }
  return [...out];
}

/** Bugs first, then priority:high, then oldest. */
export function priorityOf(issue) {
  return (has(issue, LABELS.bug) ? 0 : 2) + (has(issue, LABELS.priorityHigh) ? 0 : 1);
}

/** Branch convention every dev agent uses; the watchdog links issue↔PR by it. */
export const branchPrefixFor = (issueNumber) => `agent/issue-${issueNumber}-`;

/**
 * Pick the issues to start now.
 * @param {{readyIssues: any[], claimedCount: number, openAgentPrCount: number, maxWip?: number}} s
 * @returns {{start: any[], skipped: {number:number, reason:string}[]}}
 */
export function planDispatch({ readyIssues, claimedCount, openAgentPrCount, maxWip = DEFAULTS.maxWip, maxOpenPrs = DEFAULTS.maxOpenPrs, openIssueNumbers = null }) {
  const skipped = [];
  const eligible = [];
  for (const issue of readyIssues) {
    if (issue.state && issue.state !== 'OPEN') continue;
    if (has(issue, LABELS.needsKaran)) {
      skipped.push({ number: issue.number, reason: 'needs:karan' });
    } else if (has(issue, LABELS.claimed)) {
      skipped.push({ number: issue.number, reason: 'already claimed' });
    } else if (!isTrustedAuthor(issue)) {
      skipped.push({ number: issue.number, reason: 'untrusted author' });
    } else if (openIssueNumbers && blockersOf(issue).some((n) => openIssueNumbers.has(n))) {
      skipped.push({ number: issue.number, reason: `blocked by #${blockersOf(issue).filter((n) => openIssueNumbers.has(n)).join(', #')}` });
    } else {
      eligible.push(issue);
    }
  }
  eligible.sort(
    (a, b) =>
      (has(a, LABELS.bug) ? 0 : 1) - (has(b, LABELS.bug) ? 0 : 1) || // bugs always before stories
      orderOf(a) - orderOf(b) ||
      priorityOf(a) - priorityOf(b) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  // claimedCount = issues an agent is actively working (claimed, no PR yet). PRs waiting on
  // CI/review/merge don't hold an agent slot (that deadlocked the pipeline); they are capped
  // separately so unmerged work can't pile up without bound.
  const slots = openAgentPrCount >= maxOpenPrs ? 0 : Math.max(0, maxWip - claimedCount);
  return { start: eligible.slice(0, slots), skipped };
}

const hoursBetween = (fromIso, now) => (now - Date.parse(fromIso)) / 3_600_000;
const countMarker = (comments, marker) => (comments ?? []).filter((c) => (c.body ?? '').includes(marker)).length;

/**
 * The merged PR that already delivered an issue, if any: one whose closing references
 * include the issue, or one from the issue's agent branch. Only PRs merged at or after
 * `since` (the current claim) count, so a reopened, re-claimed issue is not closed by
 * the PR that shipped its first attempt.
 * @param {number} issueNumber
 * @param {{number:number, headRefName?:string, mergedAt?:string, closingIssuesReferences?:{number:number}[]}[]} mergedPrs
 * @param {string} [since] ISO time of the current claim
 */
export function findMergedPrFor(issueNumber, mergedPrs, since) {
  const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  return (
    (mergedPrs ?? []).find(
      (p) =>
        p.mergedAt &&
        Date.parse(p.mergedAt) >= sinceMs &&
        ((p.closingIssuesReferences ?? []).some((r) => r.number === issueNumber) ||
          (p.headRefName ?? '').startsWith(branchPrefixFor(issueNumber))),
    ) ?? null
  );
}

/**
 * Watchdog decisions for one claimed issue.
 * `mergedPr`: a PR merged since the claim that delivers this issue (see findMergedPrFor).
 * When there is no open PR but the work already merged, the issue is closed as completed
 * instead of being requeued (GitHub does not always auto-close on merge — #635).
 * `linkedPrParked`: the open PR is parked at the fix-round cap — reported as such, not "in flight" (#924).
 * @param {{issue:any, claimedAt:string, linkedPr:any|null, mergedPr?:any|null, linkedPrParked?:boolean, comments:any[], now:number, cfg?:object}} s
 * @returns {{action:'none'|'requeue'|'escalate'|'overdue'|'close', reason:string}}
 */
export function judgeClaimedIssue({ issue, claimedAt, linkedPr, mergedPr = null, linkedPrParked = false, comments, now, cfg = DEFAULTS }) {
  if (!linkedPr && mergedPr) {
    return { action: 'close', reason: `delivered by merged PR #${mergedPr.number}` };
  }
  if (!linkedPr) {
    const idle = hoursBetween(claimedAt, now);
    if (idle < cfg.claimStallHours) return { action: 'none', reason: `claimed ${idle.toFixed(1)}h ago` };
    const requeues = countMarker(comments, MARKERS.requeue);
    if (requeues >= cfg.maxRequeues) {
      return { action: 'escalate', reason: `no PR after ${requeues} requeues` };
    }
    return { action: 'requeue', reason: `claimed ${idle.toFixed(1)}h with no PR` };
  }
  const sizeLabel = names(issue.labels).find((l) => l in SIZE_DAYS);
  const budgetHours = (SIZE_DAYS[sizeLabel] ?? SIZE_DAYS['size:M']) * 24;
  if (hoursBetween(claimedAt, now) > budgetHours && countMarker(comments, MARKERS.overdue) === 0) {
    return { action: 'overdue', reason: `open longer than ${sizeLabel ?? 'size:M'} budget` };
  }
  return { action: 'none', reason: linkedPrParked ? `PR #${linkedPr.number} ${PARKED_REASON}` : 'PR in flight' };
}

export const PARKED_REASON = 'parked at fix-round cap';
const LEGACY_PARKED = /^Fix-round cap \(\d+\) reached/m;

/**
 * Fix-round budget for one PR, from its comments. agent-fix.yml (via fix-round.mjs gate)
 * posts one `<!-- agent:fix-round -->\nFix round n/max: <reason>` comment per round;
 * merge-conflict rounds (reason starts with CONFLICT_REASON) do not count toward
 * the cap (#924). A PR is parked once its counted rounds reach `max`; every
 * dispatch site checks this so no further agent-fix runs (and no repeated
 * "parked" comments) are started for it. Comments are in chronological order; a
 * MARKERS.fixCapReset comment (orchestrator release) zeroes the counts before it.
 * Only comments from trusted authors (isTrustedAuthor: OWNER/MEMBER/COLLABORATOR or
 * the pipeline bots) count — otherwise anyone able to comment could re-arm the budget
 * with a reset marker (unlimited paid runs) or park a PR with a fake cap marker.
 * Callers must pass comments with author identity (gh.mjs prComments — REST, which
 * reports bots as "<name>[bot]" with is_bot; `gh pr list/view --json comments` drops
 * the [bot] suffix, so those comments are not trusted here).
 * @param {{body?:string, author?:{login?:string, is_bot?:boolean}, authorAssociation?:string}[]} comments
 * @param {number} [max]
 * @returns {{rounds:number, conflictRounds:number, max:number, atCap:boolean, parkedNoted:boolean}}
 */
export function fixRoundState(comments, max = DEFAULTS.maxFixRounds) {
  let rounds = 0;
  let conflictRounds = 0;
  let parkedNoted = false;
  for (const c of comments ?? []) {
    if (!isTrustedAuthor(c)) continue;
    const body = c.body ?? '';
    if (body.includes(MARKERS.fixCapReset)) {
      rounds = 0;
      conflictRounds = 0;
      parkedNoted = false;
      continue;
    }
    // Pre-#924 agent-fix.yml parked with a plain "Fix-round cap (N) reached" comment (no marker,
    // counting merge rounds). Treat it as parked so those PRs stop being re-dispatched; the
    // orchestrator releases them with MARKERS.fixCapReset.
    if (body.includes(MARKERS.fixCap) || LEGACY_PARKED.test(body)) parkedNoted = true;
    if (!body.includes(MARKERS.fixRound)) continue;
    // "Fix round n/max: <reason>" (or the conflict-round variant): reason = text after the first ": ".
    const line = body.slice(body.indexOf(MARKERS.fixRound) + MARKERS.fixRound.length).trim().split('\n')[0];
    const reason = line.includes(': ') ? line.slice(line.indexOf(': ') + 2) : '';
    if (isConflictReason(reason)) conflictRounds += 1;
    else rounds += 1;
  }
  return { rounds, conflictRounds, max, atCap: rounds >= max || parkedNoted, parkedNoted };
}

/** True for a fix-round reason that only asks to merge main in (see CONFLICT_REASON). */
export const isConflictReason = (reason) => String(reason ?? '').trim().toLowerCase().startsWith(CONFLICT_REASON);

/**
 * What agent-fix.yml's round-cap step should do for a new dispatch.
 *   start → post the fix-round comment and run the round.
 *   park  → first time at the cap: post the parked comment (with MARKERS.fixCap) once,
 *           label agent:stuck (orchestrator queue — repeated failures are not an owner
 *           decision, escalation policy 2026-11-15). A PR that already carries
 *           needs:karan keeps it; this never adds or removes it.
 *   skip  → already parked and noted: exit without commenting or relabelling.
 * Merge-conflict rounds don't count toward the cap (and are numbered on their own
 * counter), but a PR already parked gets no rounds of any kind until the orchestrator
 * releases it with a MARKERS.fixCapReset comment.
 * @param {{comments:{body?:string}[], reason?:string, max?:number}} s
 * @returns {{action:'start'|'park'|'skip', round:number, conflict:boolean, state:ReturnType<typeof fixRoundState>}}
 */
export function planFixRound({ comments, reason = '', max = DEFAULTS.maxFixRounds }) {
  const state = fixRoundState(comments, max);
  const conflict = isConflictReason(reason);
  if (state.atCap) return { action: state.parkedNoted ? 'skip' : 'park', round: state.rounds, conflict, state };
  return { action: 'start', round: (conflict ? state.conflictRounds : state.rounds) + 1, conflict, state };
}

/**
 * Watchdog decisions for one open agent PR.
 * `fixRounds` (from fixRoundState): a PR parked at the fix-round cap is reported as
 * parked regardless of `updatedAt` — bot comments keep bumping it, which used to
 * make parked PRs look "moving" (#924).
 * @param {{pr:any, now:number, cfg?:object, fixRounds?:{atCap:boolean}|null}} s  pr: {updatedAt, isDraft, checks:[{name,bucket,completedAt}], reviewDecision}
 * @returns {{action:'none'|'rereview'|'fix', reason:string}}
 */
export function judgeAgentPr({ pr, now, cfg = DEFAULTS, fixRounds = null }) {
  if (fixRounds?.atCap) return { action: 'none', reason: PARKED_REASON };
  if (pr.isDraft) return { action: 'none', reason: 'draft' };
  const required = (pr.checks ?? []).filter((c) => c.name === 'build' || c.name === 'lighthouse');
  const red = required.filter((c) => c.bucket === 'fail');
  if (red.length > 0) {
    const since = Math.min(...red.map((c) => Date.parse(c.completedAt ?? pr.updatedAt)));
    if ((now - since) / 3_600_000 >= cfg.ciRedHours) {
      return { action: 'fix', reason: `required check red: ${red.map((c) => c.name).join(', ')}` };
    }
    return { action: 'none', reason: 'CI red, within grace' };
  }
  if (hoursBetween(pr.updatedAt, now) >= cfg.prStaleHours && pr.reviewDecision !== 'APPROVED') {
    return { action: 'rereview', reason: `no activity for ${cfg.prStaleHours}h+` };
  }
  return { action: 'none', reason: 'moving' };
}

/**
 * Paths whose changes must wait for Karan even when the reviewer approves
 * (owner standing rules: spend, legal, pricing math, destructive data changes).
 */
export const SENSITIVE_PATHS = [
  // Owner escalation policy (2026-11-15): hold only what is an app/business decision or
  // costs money — legal copy, infrastructure spend, builder tenant data. Everything else
  // merges after review + every check green.
  /^docs\/legal\//,
  /^infra\/bicep\//,
  /^config\/builders\//,
];

/**
 * Checks that depend on live Azure state or Azure quotas rather than on the
 * PR's code. They never block a PR and never trigger a code fix round; when
 * they fail on main they become `ops` issues.
 */
export const ENV_CHECKS = new Set(['backup-config', 'community-stats-freshness', 'preview (SWA)']);

/**
 * Decide what to do about a failed CI run.
 * @param {{failedJobs:string[], pr:null|{number:number, author:string, labels:string[], behindBy:number}}} s
 * @returns {{action:'none'|'rebase-dependabot'|'update-branch'|'fix'|'comment'|'main-issue', codeJobs:string[], envJobs:string[]}}
 */
export function triageFailure({ failedJobs, pr }) {
  const envJobs = failedJobs.filter((j) => ENV_CHECKS.has(j));
  const codeJobs = failedJobs.filter((j) => !ENV_CHECKS.has(j));
  if (!pr) return { action: codeJobs.length || envJobs.length ? 'main-issue' : 'none', codeJobs, envJobs };
  if (codeJobs.length === 0) return { action: 'none', codeJobs, envJobs };
  const isDependabot = pr.author === 'dependabot[bot]' || pr.author === 'app/dependabot';
  if (pr.behindBy > 0) {
    return { action: isDependabot ? 'rebase-dependabot' : 'update-branch', codeJobs, envJobs };
  }
  if (isDependabot || (pr.labels ?? []).includes(LABELS.pr)) return { action: 'fix', codeJobs, envJobs };
  return { action: 'comment', codeJobs, envJobs };
}

/**
 * Owner rule (2026-11-13): approved design stories wait in `backlog` until every
 * current bug is fixed. Bugs parked on an owner decision (needs:karan) don't block.
 * @param {{openBugs:any[], backlogCount:number}} s
 * @returns {{release:boolean, blockingBugs:number[]}}
 */
export function shouldReleaseBacklog({ openBugs, backlogCount, cutoff = null }) {
  // "Current bugs" = bugs that already existed when the backlog stories were written (cutoff =
  // newest backlog issue's creation time); QA keeps filing new ones, which interleave by priority.
  const blocking = openBugs
    .filter((i) => !has(i, LABELS.needsKaran))
    .filter((i) => !cutoff || Date.parse(i.createdAt) <= Date.parse(cutoff))
    .map((i) => i.number);
  return { release: backlogCount > 0 && blocking.length === 0, blockingBugs: blocking };
}

/** Checks that test code (a red one never gets re-run by the merger). */
export const CODE_CHECKS = new Set(['build', 'lighthouse', 'dependency-audit', 'secrets-scan']);

/**
 * Merger decision for one PR (owner rule 2026-11-13: merge only when EVERY check is green).
 * @param {{author:string, isDraft:boolean, labels:string[], verdict:string, mergeState:string,
 *          checks:{name:string,bucket:string}[]}} pr
 * @returns {{action:'skip'|'wait'|'rerun'|'update'|'merge', reason:string}}
 */
export function decideMerge(pr) {
  if (pr.isDraft) return { action: 'skip', reason: 'draft' };
  // Owner PRs aren't parked: Karan delegated pipeline changes (2026-11-14). Agent PRs still are.
  if (pr.labels.includes(LABELS.needsKaran) && pr.author !== 'ksingh31') return { action: 'skip', reason: 'needs:karan' };
  const checks = pr.checks.filter((c) => c.bucket !== 'skipping');
  if (checks.length === 0) return { action: 'wait', reason: 'no checks yet' };
  if (checks.some((c) => c.bucket === 'pending')) return { action: 'wait', reason: 'checks running' };
  const codeRed = checks.filter((c) => c.bucket === 'fail' && CODE_CHECKS.has(c.name)).map((c) => c.name);
  if (codeRed.length) return { action: 'skip', reason: `code check red (${codeRed.join(', ')}) — CI triage/fix agent` };
  const envRed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
  if (envRed.length) return { action: 'rerun', reason: `environment checks red (${envRed.join(', ')})` };
  const approved =
    pr.author === 'ksingh31' || pr.verdict === 'APPROVE' || pr.labels.includes('agent:approved');
  if (!approved) return { action: 'skip', reason: pr.verdict ? `verdict ${pr.verdict}` : 'awaiting review' };
  if (pr.mergeState === 'BEHIND') return { action: 'update', reason: 'green but behind main' };
  if (pr.mergeState === 'CLEAN' || pr.mergeState === 'HAS_HOOKS' || pr.mergeState === 'UNSTABLE') {
    return { action: 'merge', reason: 'every check green and approved' };
  }
  return { action: 'skip', reason: `merge state ${pr.mergeState}` };
}

export function sensitiveFiles(paths) {
  return paths.filter((p) => SENSITIVE_PATHS.some((re) => re.test(p)));
}

/** Issue numbers a PR body closes via GitHub keywords ("Fixes #12", "closes #3, resolves #4"). */
export function linkedIssues(body) {
  const out = new Set();
  for (const m of String(body ?? '').matchAll(/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi)) out.add(Number(m[1]));
  return [...out];
}
