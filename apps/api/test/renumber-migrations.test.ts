/**
 * #900: tools/renumber-migrations.mjs — auto-renumber colliding migrations
 * after merging main. Each scenario builds a throwaway git repo with the
 * real migrations layout and drives the CLI end to end (git + fs, no fakes).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOL = join(__dirname, '..', '..', '..', 'tools', 'renumber-migrations.mjs');
const DIR = 'apps/api/src/db/migrations';

interface Entry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function journalPath(repo: string): string {
  return join(repo, DIR, 'meta', '_journal.json');
}

function readJournal(repo: string): { version: string; dialect: string; entries: Entry[] } {
  return JSON.parse(readFileSync(journalPath(repo), 'utf8'));
}

/** Add a migration the way drizzle-kit does: SQL file + appended journal entry. */
function addMigration(repo: string, tag: string, sql: string, when: number): void {
  writeFileSync(join(repo, DIR, `${tag}.sql`), sql);
  const j = readJournal(repo);
  j.entries.push({ idx: j.entries.length, version: '7', when, tag, breakpoints: true });
  writeFileSync(journalPath(repo), `${JSON.stringify(j, null, '\t')}\n`);
}

function commitAll(repo: string, msg: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

/** main with 0055/0056 already merged. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'renumber-'));
  repos.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, DIR, 'meta'), { recursive: true });
  writeFileSync(journalPath(repo), `${JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }, null, '\t')}\n`);
  addMigration(repo, '0055_builder_partners', 'CREATE TABLE "a" ("id" int);\n', 1_000_000);
  addMigration(repo, '0056_other', 'CREATE TABLE "b" ("id" int);\n', 2_000_000);
  commitAll(repo, 'main');
  return repo;
}

function run(repo: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Branches A and B both add 0057; A merges first; B merges main (conflict). */
function collidingMerge(repo: string, bMigrations: Array<[string, string]> = [['0057_branch_b', 'CREATE TABLE "bb" ("id" int);\n']]): void {
  git(repo, 'switch', '-q', '-c', 'branch-a');
  addMigration(repo, '0057_branch_a', 'CREATE TABLE "aa" ("id" int);\n', 3_000_000);
  commitAll(repo, 'A');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'switch', '-q', '-c', 'branch-b');
  bMigrations.forEach(([tag, sql], i) => addMigration(repo, tag, sql, 3_000_000 + i));
  commitAll(repo, 'B');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'merge', '-q', '--ff-only', 'branch-a');
  git(repo, 'switch', '-q', 'branch-b');
  const merge = spawnSync('git', ['merge', '-q', '--no-edit', 'main'], { cwd: repo, encoding: 'utf8' });
  expect(merge.status, 'the journal should conflict, as in the real incidents').not.toBe(0);
  expect(readFileSync(journalPath(repo), 'utf8')).toContain('<<<<<<<');
}

function expectValidJournal(repo: string, tags: string[]): Entry[] {
  const j = readJournal(repo);
  expect(j.version).toBe('7');
  expect(j.dialect).toBe('postgresql');
  expect(j.entries.map((e) => e.tag)).toEqual(tags);
  j.entries.forEach((e, i) => {
    expect(e.idx).toBe(i);
    expect(existsSync(join(repo, DIR, `${e.tag}.sql`))).toBe(true);
    if (i > 0) expect(e.when).toBeGreaterThan(j.entries[i - 1]!.when);
  });
  return j.entries;
}

describe('renumber-migrations (#900)', () => {
  it('AC1: A and B both add 0057; after A merges, merging main into B yields B as 0058 with a valid journal', () => {
    const repo = initRepo();
    collidingMerge(repo);

    const r = run(repo);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('0057_branch_b → 0058_branch_b');

    expect(existsSync(join(repo, DIR, '0057_branch_b.sql'))).toBe(false);
    expect(readFileSync(join(repo, DIR, '0058_branch_b.sql'), 'utf8')).toBe('CREATE TABLE "bb" ("id" int);\n');
    expect(readFileSync(join(repo, DIR, '0057_branch_a.sql'), 'utf8')).toBe('CREATE TABLE "aa" ("id" int);\n');
    const entries = expectValidJournal(repo, ['0055_builder_partners', '0056_other', '0057_branch_a', '0058_branch_b']);
    expect(entries[3]!.when).toBeGreaterThan(entries[2]!.when);

    // conflict resolved and staged: the merge commits cleanly
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('');
    git(repo, 'commit', '-q', '--no-edit');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');

    // idempotent: a second run is a no-op
    const again = run(repo);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain('nothing to do');
  });

  it('resolves a diff3-style conflict (merge.conflictStyle=diff3) the same way', () => {
    const repo = initRepo();
    git(repo, 'config', 'merge.conflictStyle', 'diff3');
    collidingMerge(repo);
    const r = run(repo);
    expect(r.status, r.out).toBe(0);
    expectValidJournal(repo, ['0055_builder_partners', '0056_other', '0057_branch_a', '0058_branch_b']);
  });

  it('renumbers several branch migrations in order and appends them after main', () => {
    const repo = initRepo();
    collidingMerge(repo, [
      ['0057_first', 'CREATE TABLE "f1" ("id" int);\n'],
      ['0058_second', 'CREATE TABLE "f2" ("id" int);\n'],
    ]);
    const r = run(repo);
    expect(r.status, r.out).toBe(0);
    expectValidJournal(repo, ['0055_builder_partners', '0056_other', '0057_branch_a', '0058_first', '0059_second']);
  });

  it('also fixes a merge that was committed with the conflict hand-resolved to "theirs + ours" but colliding numbers', () => {
    const repo = initRepo();
    collidingMerge(repo);
    // naive resolution: keep both entries, numbers still collide
    const j = JSON.parse(git(repo, 'show', `HEAD:${DIR}/meta/_journal.json`)) as { entries: Entry[] };
    git(repo, 'checkout', '--theirs', '--', `${DIR}/meta/_journal.json`);
    const theirs = readJournal(repo);
    theirs.entries.push({ ...j.entries.find((e) => e.tag === '0057_branch_b')!, idx: theirs.entries.length });
    writeFileSync(journalPath(repo), `${JSON.stringify(theirs, null, '\t')}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--no-edit');

    const r = run(repo);
    expect(r.status, r.out).toBe(0);
    expectValidJournal(repo, ['0055_builder_partners', '0056_other', '0057_branch_a', '0058_branch_b']);
  });

  it('AC2: no-op on a branch without new migrations', () => {
    const repo = initRepo();
    git(repo, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    commitAll(repo, 'feature');
    const before = readFileSync(journalPath(repo), 'utf8');
    const r = run(repo, '--base', 'main');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('nothing to do');
    expect(readFileSync(journalPath(repo), 'utf8')).toBe(before);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('no-op when the branch migration already sits after main', () => {
    const repo = initRepo();
    git(repo, 'switch', '-q', '-c', 'feature');
    addMigration(repo, '0057_new', 'CREATE TABLE "n" ("id" int);\n', 3_000_000);
    commitAll(repo, 'feature');
    const r = run(repo, '--base', 'main');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('nothing to do');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('--dry-run reports the plan without touching files', () => {
    const repo = initRepo();
    collidingMerge(repo);
    const before = readFileSync(journalPath(repo), 'utf8');
    const r = run(repo, '--dry-run');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('0057_branch_b → 0058_branch_b');
    expect(readFileSync(journalPath(repo), 'utf8')).toBe(before);
    expect(existsSync(join(repo, DIR, '0057_branch_b.sql'))).toBe(true);
  });

  it('fails loudly when the migration to renumber is byte-identical to one main already applied', () => {
    const repo = initRepo();
    // B carries A's exact SQL under its own name: drizzle would treat it as applied (hash match)
    collidingMerge(repo, [['0057_dupe', 'CREATE TABLE "aa" ("id" int);\n']]);
    const r = run(repo);
    expect(r.status).toBe(1);
    expect(r.out).toContain('already applied');
    expect(existsSync(join(repo, DIR, '0057_dupe.sql'))).toBe(true);
  });

  it('fails loudly when the migration is in the --applied list', () => {
    const repo = initRepo();
    collidingMerge(repo);
    writeFileSync(join(repo, 'applied.txt'), '# exported from __drizzle_migrations\n0057_branch_b\n');
    const r = run(repo, '--applied', 'applied.txt');
    expect(r.status).toBe(1);
    expect(r.out).toContain('applied list');
    expect(existsSync(join(repo, DIR, '0057_branch_b.sql'))).toBe(true);
  });

  it('skips cleanly when there is no base ref', () => {
    const repo = initRepo();
    const r = run(repo, '--base', 'does-not-exist');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('skipped');
  });
});

describe('real migrations journal (#900)', () => {
  const real = join(__dirname, '..', 'src', 'db', 'migrations');
  const journal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] };

  it('has sequential idx, unique tags/numbers, and a SQL file per entry', () => {
    const numbers = new Set<string>();
    journal.entries.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i);
      expect(existsSync(join(real, `${e.tag}.sql`)), `${e.tag}.sql`).toBe(true);
      const n = e.tag.split('_')[0]!;
      expect(numbers.has(n), `duplicate migration number ${n}`).toBe(false);
      numbers.add(n);
    });
  });

  it('every entry after 0046 has a `when` later than every earlier entry (drizzle skips older ones)', () => {
    let max = 0;
    for (const e of journal.entries) {
      if (Number(e.tag.split('_')[0]) > 46) expect(e.when, e.tag).toBeGreaterThan(max);
      max = Math.max(max, e.when);
    }
  });
});
