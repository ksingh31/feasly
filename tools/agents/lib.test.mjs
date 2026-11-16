// Unit tests for the agent pipeline decision logic. Run: node --test tools/agents/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from './lib.mjs';
import {
  planDispatch, orderOf, blockersOf, shouldReleaseBacklog, decideMerge, judgeClaimedIssue, findMergedPrFor, judgeAgentPr, areaOf, isTrustedAuthor, sensitiveFiles, triageFailure, MARKERS, DEFAULTS,
} from './lib.mjs';

const H = 3_600_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');
const ago = (h) => new Date(NOW - h * H).toISOString();
const issue = (n, labels = [], extra = {}) => ({
  number: n, labels: labels.map((name) => ({ name })), authorAssociation: 'OWNER',
  author: { login: 'ksingh31' }, createdAt: ago(100 - n), state: 'OPEN', ...extra,
});

test('dispatch fills free WIP slots, bugs and priority first', () => {
  const ready = [issue(1), issue(2, ['bug']), issue(3, ['priority:high']), issue(4, ['bug', 'priority:high'])];
  const { start } = planDispatch({ readyIssues: ready, claimedCount: 0, openAgentPrCount: 0, maxWip: 2 });
  assert.deepEqual(start.map((i) => i.number), [4, 2]);
});

test('dispatch: bugs first, then the explicit Order: sequence, then priority', () => {
  const ready = [
    issue(1, ['bug', 'priority:high'], { body: 'x\nOrder: 3' }),
    issue(2, [], { body: 'Order: 1' }),
    issue(3, ['bug'], { body: 'no order' }),
    issue(4, [], { body: 'Order: 2' }),
  ];
  const { start } = planDispatch({ readyIssues: ready, claimedCount: 0, openAgentPrCount: 0, maxWip: 4 });
  assert.deepEqual(start.map((i) => i.number), [1, 3, 2, 4]);
});

test('dispatch skips issues whose blockers are still open', () => {
  const ready = [issue(5, [], { body: 'Order: 1\nBlocked by #474, #477' }), issue(6, [], { body: 'Order: 2' })];
  const { start, skipped } = planDispatch({
    readyIssues: ready, claimedCount: 0, openAgentPrCount: 0, maxWip: 2, openIssueNumbers: new Set([477]),
  });
  assert.deepEqual(start.map((i) => i.number), [6]);
  assert.equal(skipped[0].reason, 'blocked by #477');
});

test('order and blocker parsing', () => {
  assert.equal(orderOf({ body: 'foo\n Order: 12 \nbar' }), 12);
  assert.equal(orderOf({ body: 'no order here' }), Number.POSITIVE_INFINITY);
  assert.deepEqual(blockersOf({ body: 'Blocked by #1, #2\nDepends on #3\nmentions #4' }), [1, 2, 3]);
});

test('dispatch starts nothing when WIP is full', () => {
  assert.equal(planDispatch({ readyIssues: [issue(1)], claimedCount: 2, openAgentPrCount: 0, maxWip: 2 }).start.length, 0);
  // open PRs no longer hold agent slots…
  assert.equal(planDispatch({ readyIssues: [issue(1)], claimedCount: 0, openAgentPrCount: 4, maxWip: 2 }).start.length, 1);
  // …but are capped so unmerged work can't pile up
  assert.equal(planDispatch({ readyIssues: [issue(1)], claimedCount: 0, openAgentPrCount: 8, maxWip: 2, maxOpenPrs: 8 }).start.length, 0);
});

test('dispatch skips needs:karan, claimed, and untrusted authors', () => {
  const outsider = issue(9, [], { authorAssociation: 'NONE', author: { login: 'stranger' } });
  const { start, skipped } = planDispatch({
    readyIssues: [issue(1, ['needs:karan']), issue(2, ['agent:claimed']), outsider],
    claimedCount: 0, openAgentPrCount: 0, maxWip: 5,
  });
  assert.equal(start.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason), ['needs:karan', 'already claimed', 'untrusted author']);
});

test('bot-filed issues (QA bugs) are trusted', () => {
  assert.equal(isTrustedAuthor(issue(1, [], { authorAssociation: 'NONE', author: { login: 'claude[bot]' } })), true);
});

test('area routing', () => {
  assert.equal(areaOf(issue(1, ['area:api'])), 'api');
  assert.equal(areaOf(issue(1, ['area:infra'])), 'infra');
  assert.equal(areaOf(issue(1)), 'web');
});

test('claimed issue: no PR within grace → none; past grace → requeue; repeated → escalate', () => {
  const base = { issue: issue(1), linkedPr: null, now: NOW, cfg: DEFAULTS };
  assert.equal(judgeClaimedIssue({ ...base, claimedAt: ago(1), comments: [] }).action, 'none');
  assert.equal(judgeClaimedIssue({ ...base, claimedAt: ago(5), comments: [] }).action, 'requeue');
  const twice = [{ body: MARKERS.requeue }, { body: `x ${MARKERS.requeue}` }];
  assert.equal(judgeClaimedIssue({ ...base, claimedAt: ago(5), comments: twice }).action, 'escalate');
});

test('claimed issue whose PR already merged → close, never requeue or escalate (#635)', () => {
  const base = { issue: issue(1), linkedPr: null, now: NOW, cfg: DEFAULTS, mergedPr: { number: 9 } };
  assert.deepEqual(judgeClaimedIssue({ ...base, claimedAt: ago(1), comments: [] }), { action: 'close', reason: 'delivered by merged PR #9' });
  assert.equal(judgeClaimedIssue({ ...base, claimedAt: ago(5), comments: [] }).action, 'close');
  const twice = [{ body: MARKERS.requeue }, { body: MARKERS.requeue }];
  assert.equal(judgeClaimedIssue({ ...base, claimedAt: ago(5), comments: twice }).action, 'close');
  // An open PR (follow-up work in flight) still wins over an older merged one.
  assert.equal(judgeClaimedIssue({ ...base, linkedPr: { number: 10 }, issue: issue(1, ['size:L']), claimedAt: ago(5), comments: [] }).action, 'none');
});

test('findMergedPrFor: closing reference or agent branch, merged since the claim', () => {
  const merged = [
    { number: 20, headRefName: 'feat/ui-kit', mergedAt: ago(2), closingIssuesReferences: [{ number: 501 }] },
    { number: 21, headRefName: 'agent/issue-502-thing', mergedAt: ago(2), closingIssuesReferences: [] },
    { number: 22, headRefName: 'agent/issue-5030-other', mergedAt: ago(2) },
    { number: 23, headRefName: 'fix/old', mergedAt: ago(50), closingIssuesReferences: [{ number: 504 }] },
  ];
  assert.equal(findMergedPrFor(501, merged, ago(5))?.number, 20);
  assert.equal(findMergedPrFor(502, merged, ago(5))?.number, 21);
  assert.equal(findMergedPrFor(503, merged, ago(5)), null); // prefix must not match issue-5030
  assert.equal(findMergedPrFor(504, merged, ago(5)), null); // merged before this claim (reopened issue)
  assert.equal(findMergedPrFor(504, merged)?.number, 23);
  assert.equal(findMergedPrFor(501, [], ago(5)), null);
  assert.equal(findMergedPrFor(501, [{ number: 24, closingIssuesReferences: [{ number: 501 }] }], ago(5)), null); // not merged
});

test('claimed issue with PR: overdue once past its size budget', () => {
  const base = { linkedPr: { number: 7 }, now: NOW, cfg: DEFAULTS };
  assert.equal(judgeClaimedIssue({ ...base, issue: issue(1, ['size:S']), claimedAt: ago(30), comments: [] }).action, 'overdue');
  assert.equal(judgeClaimedIssue({ ...base, issue: issue(1, ['size:L']), claimedAt: ago(30), comments: [] }).action, 'none');
  assert.equal(
    judgeClaimedIssue({ ...base, issue: issue(1, ['size:S']), claimedAt: ago(30), comments: [{ body: MARKERS.overdue }] }).action,
    'none',
  );
});

test('agent PR: red required check past grace → fix; stale → rereview; approved+stale → none', () => {
  const red = { isDraft: false, updatedAt: ago(1), checks: [{ name: 'build', bucket: 'fail', completedAt: ago(13) }] };
  assert.equal(judgeAgentPr({ pr: red, now: NOW }).action, 'fix');
  const redFresh = { ...red, checks: [{ name: 'build', bucket: 'fail', completedAt: ago(2) }] };
  assert.equal(judgeAgentPr({ pr: redFresh, now: NOW }).action, 'none');
  const nonRequiredRed = { ...red, checks: [{ name: 'dependency-audit', bucket: 'fail', completedAt: ago(20) }] };
  assert.equal(judgeAgentPr({ pr: nonRequiredRed, now: NOW }).action, 'none');
  assert.equal(judgeAgentPr({ pr: { isDraft: false, updatedAt: ago(30), checks: [] }, now: NOW }).action, 'rereview');
  assert.equal(
    judgeAgentPr({ pr: { isDraft: false, updatedAt: ago(30), checks: [], reviewDecision: 'APPROVED' }, now: NOW }).action,
    'none',
  );
});

test('triage: env-only failures never blame the PR', () => {
  const pr = { number: 1, author: 'ksingh31', labels: ['agent:pr'], behindBy: 0 };
  assert.equal(triageFailure({ failedJobs: ['community-stats-freshness', 'preview (SWA)'], pr }).action, 'none');
});

test('triage: stale branches are updated before any fix round', () => {
  const dep = { number: 2, author: 'dependabot[bot]', labels: [], behindBy: 5 };
  assert.equal(triageFailure({ failedJobs: ['build'], pr: dep }).action, 'rebase-dependabot');
  const agent = { number: 3, author: 'claude[bot]', labels: ['agent:pr'], behindBy: 2 };
  assert.equal(triageFailure({ failedJobs: ['build'], pr: agent }).action, 'update-branch');
});

test('triage: up-to-date agent/dependabot PRs get a fix round; human PRs a comment', () => {
  assert.equal(triageFailure({ failedJobs: ['build'], pr: { number: 4, author: 'claude[bot]', labels: ['agent:pr'], behindBy: 0 } }).action, 'fix');
  assert.equal(triageFailure({ failedJobs: ['lighthouse'], pr: { number: 5, author: 'dependabot[bot]', labels: [], behindBy: 0 } }).action, 'fix');
  assert.equal(triageFailure({ failedJobs: ['build'], pr: { number: 6, author: 'ksingh31', labels: [], behindBy: 0 } }).action, 'comment');
});

test('triage: any failure on main opens/updates the main-is-red issue', () => {
  const r = triageFailure({ failedJobs: ['dependency-audit', 'backup-config'], pr: null });
  assert.equal(r.action, 'main-issue');
  assert.deepEqual(r.codeJobs, ['dependency-audit']);
  assert.deepEqual(r.envJobs, ['backup-config']);
});

test('backlog waits until every non-parked bug is closed', () => {
  assert.deepEqual(shouldReleaseBacklog({ openBugs: [issue(1, ['bug']), issue(2, ['bug', 'needs:karan'])], backlogCount: 5 }),
    { release: false, blockingBugs: [1] });
  assert.equal(shouldReleaseBacklog({ openBugs: [issue(2, ['bug', 'needs:karan'])], backlogCount: 5 }).release, true);
  assert.equal(shouldReleaseBacklog({ openBugs: [], backlogCount: 0 }).release, false);
});

test('merger: only every-check-green + approved merges', () => {
  const base = { author: 'claude[bot]', isDraft: false, labels: ['agent:pr'], verdict: 'APPROVE', mergeState: 'CLEAN',
    checks: [{ name: 'build', bucket: 'pass' }, { name: 'preview (SWA)', bucket: 'pass' }, { name: 'deploy-dev', bucket: 'skipping' }] };
  assert.equal(decideMerge(base).action, 'merge');
  assert.equal(decideMerge({ ...base, checks: [{ name: 'build', bucket: 'pending' }] }).action, 'wait');
  assert.equal(decideMerge({ ...base, checks: [{ name: 'build', bucket: 'fail' }] }).action, 'skip');
  assert.equal(decideMerge({ ...base, checks: [{ name: 'build', bucket: 'pass' }, { name: 'preview (SWA)', bucket: 'fail' }] }).action, 'rerun');
  assert.equal(decideMerge({ ...base, verdict: 'REQUEST_CHANGES' }).action, 'skip');
  assert.equal(decideMerge({ ...base, verdict: '' }).action, 'skip');
  assert.equal(decideMerge({ ...base, author: 'ksingh31', verdict: '' }).action, 'merge');
  assert.equal(decideMerge({ ...base, mergeState: 'BEHIND' }).action, 'update');
  assert.equal(decideMerge({ ...base, labels: ['agent:pr', 'needs:karan'] }).action, 'skip');
  assert.equal(decideMerge({ ...base, author: 'ksingh31', verdict: '', labels: ['needs:karan'] }).action, 'merge');
  assert.equal(decideMerge({ ...base, mergeState: 'DIRTY' }).action, 'skip');
});

test('bugs without Order still go before ordered stories', () => {
  const ready = [issue(1, ['design'], { body: 'Order: 20' }), issue(2, ['bug'], { body: 'no order' })];
  assert.deepEqual(planDispatch({ readyIssues: ready, claimedCount: 0, openAgentPrCount: 0, maxWip: 2 }).start.map((i) => i.number), [2, 1]);
});

test('backlog waits only for bugs that existed when the stories were written', () => {
  const old = issue(1, ['bug'], { createdAt: '2026-11-13T10:00:00Z' });
  const fresh = issue(2, ['bug'], { createdAt: '2026-11-14T01:00:00Z' });
  assert.equal(shouldReleaseBacklog({ openBugs: [fresh], backlogCount: 3, cutoff: '2026-11-13T14:00:00Z' }).release, true);
  assert.equal(shouldReleaseBacklog({ openBugs: [old, fresh], backlogCount: 3, cutoff: '2026-11-13T14:00:00Z' }).release, false);
});

test('sensitive paths hold auto-merge', () => {
  const hits = sensitiveFiles([
    'apps/web/src/app/features/landing/landing.ts',
    'infra/bicep/main.bicep',
    'packages/cost-engine/src/engine.ts',
    'apps/api/src/services/billing-service.ts',
    'docs/legal/approved-copy.md',
  ]);
  assert.equal(hits.length, 2); // only infra/bicep + docs/legal of the samples
});

test('linkedIssues extracts closing-keyword references only', () => {
  const { linkedIssues } = lib;
  assert.deepEqual(linkedIssues('Fixes #12\ncloses #3, Resolves #4. See #99. fixed #12'), [12, 3, 4]);
  assert.deepEqual(linkedIssues(''), []);
  assert.deepEqual(linkedIssues(null), []);
});

// --- fix-round cap (#924) ---
// prComments (REST) shape: bots come back as "<name>[bot]" with is_bot.
const BOT = { author: { login: 'github-actions[bot]', is_bot: true }, authorAssociation: 'CONTRIBUTOR' };
const STRANGER = { author: { login: 'mallory', is_bot: false }, authorAssociation: 'NONE' };
const c = (body, who = BOT) => ({ ...who, body });
const round = (n, reason = 'review requested changes', max = 5) => c(`${MARKERS.fixRound}\nFix round ${n}/${max}: ${reason}`);
const conflictRound = (n) => c(`${MARKERS.fixRound}\nFix round ${n} (merge main — not counted toward the 5-round cap): merge conflict with main: merge main in, resolve, re-verify`);
const legacyConflict = (n) => round(n, 'merge conflict with main: merge main in, resolve, re-verify');
const fiveRounds = [1, 2, 3, 4, 5].map((n) => round(n));

test('fixRoundState: counts rounds, merge-conflict rounds on their own counter', () => {
  const s = lib.fixRoundState([round(1), legacyConflict(2), conflictRound(1), round(3, 'CI failed: build'), c('chatter')], 5);
  assert.deepEqual(s, { rounds: 2, conflictRounds: 2, max: 5, atCap: false, parkedNoted: false });
  assert.equal(lib.fixRoundState(fiveRounds, 5).atCap, true);
  assert.equal(lib.fixRoundState(fiveRounds, 6).atCap, false);
  // A busy main can no longer burn the whole budget on merges (#904, #886).
  assert.equal(lib.fixRoundState([1, 2, 3, 4, 5].map(legacyConflict), 5).atCap, false);
  assert.equal(lib.fixRoundState(null).atCap, false);
});

test('fixRoundState: orchestrator reset marker releases a parked PR', () => {
  const parked = [...fiveRounds, c(`${MARKERS.fixCap}\nFix-round cap (5) reached`)];
  assert.equal(lib.fixRoundState(parked).atCap, true);
  const released = lib.fixRoundState([...parked, c(`${MARKERS.fixCapReset}\nReleased`), round(1)]);
  assert.deepEqual(released, { rounds: 1, conflictRounds: 0, max: 5, atCap: false, parkedNoted: false });
});

test('fixRoundState: markers from untrusted authors are ignored', () => {
  const parked = [...fiveRounds, c(`${MARKERS.fixCap}\nFix-round cap (5) reached`)];
  // An outsider can't re-arm the budget with a reset marker…
  assert.equal(lib.fixRoundState([...parked, c(MARKERS.fixCapReset, STRANGER)]).atCap, true);
  assert.equal(lib.planFixRound({ comments: [...parked, c(MARKERS.fixCapReset, STRANGER)], reason: 'review requested changes' }).action, 'skip');
  // …nor park a PR or burn its rounds with fake markers.
  assert.equal(lib.fixRoundState([round(1), c(MARKERS.fixCap, STRANGER)]).atCap, false);
  assert.equal(lib.fixRoundState(fiveRounds.map((r) => ({ ...r, ...STRANGER }))).rounds, 0);
  // `gh pr view --json comments` shape (bare "github-actions", no is_bot) is not trusted;
  // owner/collaborator resets are.
  assert.equal(lib.fixRoundState([{ body: round(1).body, author: { login: 'github-actions' }, authorAssociation: 'CONTRIBUTOR' }]).rounds, 0);
  assert.equal(lib.fixRoundState([...parked, c(MARKERS.fixCapReset, { author: { login: 'ksingh31' }, authorAssociation: 'OWNER' })]).atCap, false);
  assert.equal(lib.fixRoundState([...parked, c(MARKERS.fixCapReset, { author: { login: 'claude', is_bot: true }, authorAssociation: 'NONE' })]).atCap, false);
});

test('fixRoundState: legacy "parked for Karan" comment stays parked until reset', () => {
  const legacy = [round(1), round(2), legacyConflict(3), legacyConflict(4), legacyConflict(5), c('Fix-round cap (5) reached — parked for Karan.')];
  const s = lib.fixRoundState(legacy);
  assert.equal(s.rounds, 2);
  assert.equal(s.atCap, true);
  assert.equal(lib.planFixRound({ comments: legacy, reason: 'CI failed: build' }).action, 'skip');
  assert.equal(lib.fixRoundState([...legacy, c(MARKERS.fixCapReset)]).atCap, false);
  assert.equal(lib.fixRoundState([c('quoting: see "Fix-round cap (5) reached" above')]).atCap, false);
});

test('planFixRound: parked comment once, then silent exits', () => {
  assert.deepEqual(
    (({ action, round: r, conflict }) => ({ action, r, conflict }))(lib.planFixRound({ comments: [round(1)], reason: 'review requested changes' })),
    { action: 'start', r: 2, conflict: false },
  );
  const conflictPlan = lib.planFixRound({ comments: [round(1), round(2)], reason: 'merge conflict with main: merge main in' });
  assert.equal(conflictPlan.action, 'start');
  assert.equal(conflictPlan.conflict, true);
  assert.equal(conflictPlan.round, 1);
  assert.equal(lib.planFixRound({ comments: fiveRounds, reason: 'CI failed: build' }).action, 'park');
  const noted = [...fiveRounds, c(`${MARKERS.fixCap}\nFix-round cap (5) reached — parked`)];
  assert.equal(lib.planFixRound({ comments: noted, reason: 'CI failed: build' }).action, 'skip');
  // A parked PR gets no conflict rounds either (merger must not re-trigger it).
  assert.equal(lib.planFixRound({ comments: noted, reason: 'merge conflict with main: x' }).action, 'skip');
});

test('judgeAgentPr: at cap + recent bot comment → parked; below cap → unchanged', () => {
  const recent = { isDraft: false, updatedAt: ago(0.1), checks: [{ name: 'build', bucket: 'fail', completedAt: ago(20) }] };
  const atCap = lib.fixRoundState([...fiveRounds, c('Fix-round cap (5) reached — parked for Karan.')]);
  assert.deepEqual(judgeAgentPr({ pr: recent, now: NOW, fixRounds: atCap }), { action: 'none', reason: 'parked at fix-round cap' });
  const staleAtCap = { isDraft: false, updatedAt: ago(30), checks: [] };
  assert.deepEqual(judgeAgentPr({ pr: staleAtCap, now: NOW, fixRounds: atCap }), { action: 'none', reason: 'parked at fix-round cap' });
  const below = lib.fixRoundState([round(1), round(2)]);
  assert.equal(judgeAgentPr({ pr: recent, now: NOW, fixRounds: below }).action, 'fix');
  assert.equal(judgeAgentPr({ pr: staleAtCap, now: NOW, fixRounds: below }).action, 'rereview');
  assert.equal(judgeAgentPr({ pr: { isDraft: false, updatedAt: ago(1), checks: [] }, now: NOW, fixRounds: below }).reason, 'moving');
});

test('claimed issue whose PR is parked at the cap is not reported as in flight', () => {
  const base = { issue: issue(1, ['size:L']), claimedAt: ago(5), linkedPr: { number: 7 }, comments: [], now: NOW, cfg: DEFAULTS };
  assert.equal(judgeClaimedIssue(base).reason, 'PR in flight');
  assert.deepEqual(judgeClaimedIssue({ ...base, linkedPrParked: true }), { action: 'none', reason: 'PR #7 parked at fix-round cap' });
});
