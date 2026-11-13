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
};

/** Hidden comment markers so repeated runs stay idempotent. */
export const MARKERS = {
  requeue: '<!-- agent:requeue -->',
  overdue: '<!-- agent:overdue -->',
  claim: '<!-- agent:claim -->',
};

/** Authors whose issues an agent may act on (issue body is the agent's prompt). */
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
export function planDispatch({ readyIssues, claimedCount, openAgentPrCount, maxWip = DEFAULTS.maxWip, openIssueNumbers = null }) {
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
      orderOf(a) - orderOf(b) ||
      priorityOf(a) - priorityOf(b) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const wip = claimedCount + openAgentPrCount;
  const slots = Math.max(0, maxWip - wip);
  return { start: eligible.slice(0, slots), skipped };
}

const hoursBetween = (fromIso, now) => (now - Date.parse(fromIso)) / 3_600_000;
const countMarker = (comments, marker) => (comments ?? []).filter((c) => (c.body ?? '').includes(marker)).length;

/**
 * Watchdog decisions for one claimed issue.
 * @param {{issue:any, claimedAt:string, linkedPr:any|null, comments:any[], now:number, cfg?:object}} s
 * @returns {{action:'none'|'requeue'|'escalate'|'overdue', reason:string}}
 */
export function judgeClaimedIssue({ issue, claimedAt, linkedPr, comments, now, cfg = DEFAULTS }) {
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
  return { action: 'none', reason: 'PR in flight' };
}

/**
 * Watchdog decisions for one open agent PR.
 * @param {{pr:any, now:number, cfg?:object}} s  pr: {updatedAt, isDraft, checks:[{name,bucket,completedAt}], reviewDecision}
 * @returns {{action:'none'|'rereview'|'fix', reason:string}}
 */
export function judgeAgentPr({ pr, now, cfg = DEFAULTS }) {
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
  /^infra\/bicep\//,
  /^\.github\/workflows\//,
  /^tools\/agents\//,
  /^\.claude\//,
  /^CLAUDE\.md$/,
  /^apps\/api\/src\/db\/migrations\//,
  /^infra\/db\//,
  /^docs\/legal\//,
  /^packages\/cost-engine\//,
  /billing/i,
  /stripe/i,
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

export function sensitiveFiles(paths) {
  return paths.filter((p) => SENSITIVE_PATHS.some((re) => re.test(p)));
}
