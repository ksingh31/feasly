// Unit tests for the agent pipeline decision logic. Run: node --test tools/agents/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planDispatch, orderOf, blockersOf, judgeClaimedIssue, judgeAgentPr, areaOf, isTrustedAuthor, sensitiveFiles, triageFailure, MARKERS, DEFAULTS,
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

test('dispatch follows the explicit Order: sequence before priority', () => {
  const ready = [
    issue(1, ['bug', 'priority:high'], { body: 'x\nOrder: 3' }),
    issue(2, [], { body: 'Order: 1' }),
    issue(3, ['bug'], { body: 'no order' }),
    issue(4, [], { body: 'Order: 2' }),
  ];
  const { start } = planDispatch({ readyIssues: ready, claimedCount: 0, openAgentPrCount: 0, maxWip: 4 });
  assert.deepEqual(start.map((i) => i.number), [2, 4, 1, 3]);
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
  const { start } = planDispatch({ readyIssues: [issue(1)], claimedCount: 1, openAgentPrCount: 1, maxWip: 2 });
  assert.equal(start.length, 0);
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

test('sensitive paths hold auto-merge', () => {
  const hits = sensitiveFiles([
    'apps/web/src/app/features/landing/landing.ts',
    'infra/bicep/main.bicep',
    'packages/cost-engine/src/engine.ts',
    'apps/api/src/services/billing-service.ts',
    'docs/legal/approved-copy.md',
  ]);
  assert.equal(hits.length, 4);
});
