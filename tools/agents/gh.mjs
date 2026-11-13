/**
 * Thin `gh` CLI wrapper for the agent pipeline. Uses GH_TOKEN from the
 * environment (Actions: GITHUB_TOKEN). `--dry-run` on any CLI turns every
 * write into a log line so the scripts can be exercised locally safely.
 */
import { execFileSync } from 'node:child_process';

export const DRY_RUN = process.argv.includes('--dry-run');

export function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : null;
}

/** Run a mutating gh command (or log it under --dry-run). */
export function ghWrite(args) {
  if (DRY_RUN) {
    console.log(`[dry-run] gh ${args.join(' ')}`);
    return '';
  }
  return execFileSync('gh', args, { encoding: 'utf8' });
}

export function intVar(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function repoSlug() {
  return process.env.GITHUB_REPOSITORY ?? ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
}

/**
 * Open issues with a label, via REST (the only API that exposes
 * author_association, which the trust check needs). PRs are filtered out.
 */
export function listIssues(label) {
  const pages =
    ghJson(['api', `repos/${repoSlug()}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`, '--paginate', '--slurp']) ?? [];
  return pages
    .flat()
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      labels: i.labels.map((l) => ({ name: l.name })),
      author: { login: i.user?.login ?? '', is_bot: i.user?.type === 'Bot' },
      authorAssociation: i.author_association,
      createdAt: i.created_at,
      state: i.state === 'open' ? 'OPEN' : 'CLOSED',
      url: i.html_url,
      body: i.body ?? '',
    }));
}

/** Numbers of all open issues (for Blocked-by checks). */
export function openIssueNumbers() {
  const pages = ghJson(['api', `repos/${repoSlug()}/issues?state=open&per_page=100`, '--paginate', '--slurp']) ?? [];
  return new Set(pages.flat().filter((i) => !i.pull_request).map((i) => i.number));
}

export function listAgentPrs() {
  return (
    ghJson([
      'pr', 'list', '--state', 'open', '--label', 'agent:pr', '--limit', '100',
      '--json', 'number,title,headRefName,updatedAt,isDraft,reviewDecision,url,labels',
    ]) ?? []
  );
}

/** When the given label was most recently added to an issue (timeline API). */
export function labeledAt(issueNumber, label) {
  const events = ghJson(['api', `repos/${repoSlug()}/issues/${issueNumber}/events?per_page=100`, '--paginate', '--slurp']) ?? [];
  const flat = events.flat();
  const hits = flat.filter((e) => e.event === 'labeled' && e.label?.name === label);
  return hits.length ? hits[hits.length - 1].created_at : null;
}

export function issueComments(issueNumber) {
  return ghJson(['issue', 'view', String(issueNumber), '--json', 'comments'])?.comments ?? [];
}

export function prChecks(prNumber) {
  try {
    return ghJson(['pr', 'checks', String(prNumber), '--json', 'name,bucket,completedAt']) ?? [];
  } catch {
    // gh exits non-zero when checks are failing/pending but still prints JSON on stdout.
    return [];
  }
}
