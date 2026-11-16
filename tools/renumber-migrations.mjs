#!/usr/bin/env node
/**
 * Auto-renumber colliding Drizzle migrations after merging main (#900).
 *
 * Two branches that each add migration `00NN_*` plus a `_journal.json` entry
 * with the same number/idx conflict as soon as one of them merges. This tool
 * runs on the branch AFTER main is merged in (or during the conflicted merge):
 *
 *   1. finds this branch's new migrations (SQL files that main doesn't have);
 *   2. renames every one that collides with or precedes main's latest number to
 *      the next free number (and its `meta/<NNNN>_snapshot.json`, if any);
 *   3. rebuilds `_journal.json` as main's entries verbatim + the branch's
 *      entries appended (sequential idx, `when` strictly after every main
 *      entry) — which also resolves the journal's merge conflict;
 *   4. fails loudly if a migration it would rename was already applied
 *      anywhere: already in main's journal, byte-identical to a main migration
 *      (drizzle tracks applied migrations by SQL hash), or listed in an
 *      applied list (`--applied <file>` / FEASLY_APPLIED_MIGRATIONS: one tag
 *      or sha256 per line, e.g. exported from `drizzle.__drizzle_migrations`).
 *
 * A no-op (exit 0, no writes) when nothing collides. `tools/verify-local.sh`
 * runs it before the typecheck.
 *
 *   node tools/renumber-migrations.mjs [--base <ref>] [--dir <path>]
 *                                      [--applied <file>] [--dry-run]
 *
 * Base ref: --base, else MERGE_HEAD (merge in progress), else origin/main,
 * else main. When that ref is not merged into HEAD yet, the last merged main
 * commit (merge-base) is used and a note says to merge main and re-run.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_DIR = 'apps/api/src/db/migrations';
const DAY_MS = 86_400_000;
const MARKER = /^(<{7}|={7}|>{7}|\|{7})( .*)?$/;

/** Leading migration number of a tag/file name (`0057_foo.sql` → 57), or null. */
export function migrationNumber(name) {
  const m = /^(\d+)_/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Same tag with a new number prefix, keeping the prefix width (min 4). */
export function withNumber(tag, n) {
  const m = /^(\d+)(_.*)$/.exec(tag);
  if (!m) throw new Error(`not a numbered migration tag: ${tag}`);
  return String(n).padStart(Math.max(4, m[1].length), '0') + m[2];
}

export function hasConflictMarkers(text) {
  return text.split('\n').some((line) => MARKER.test(line));
}

/**
 * The two sides of a git-conflicted file: `ours` keeps the HEAD side of every
 * hunk, `theirs` the incoming side (a diff3 `|||||||` base section is dropped).
 */
export function splitConflict(text) {
  const ours = [];
  const theirs = [];
  let state = 'both';
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) state = 'ours';
    else if (line.startsWith('|||||||') && state === 'ours') state = 'base';
    else if (line.startsWith('=======') && state !== 'both') state = 'theirs';
    else if (line.startsWith('>>>>>>>') && state === 'theirs') state = 'both';
    else {
      if (state === 'both' || state === 'ours') ours.push(line);
      if (state === 'both' || state === 'theirs') theirs.push(line);
    }
  }
  return { ours: ours.join('\n'), theirs: theirs.join('\n') };
}

/**
 * Journal entries, this branch's side first. A git-conflicted journal is split
 * into its two sides (git conflicts only the differing lines inside an entry,
 * so the sides must be parsed separately); entries from the other side that
 * ours lacks follow. Duplicate tags keep the first.
 */
export function parseJournalEntries(text) {
  if (!hasConflictMarkers(text)) return JSON.parse(text).entries ?? [];
  const { ours, theirs } = splitConflict(text);
  const seen = new Set();
  const out = [];
  for (const side of [ours, theirs]) {
    for (const entry of JSON.parse(side).entries ?? []) {
      if (!seen.has(entry.tag)) {
        seen.add(entry.tag);
        out.push(entry);
      }
    }
  }
  return out;
}

/**
 * Pure planning step.
 * @param {object} p
 * @param {{entries: object[]}} p.baseJournal  main's journal (parsed)
 * @param {string[]} p.baseSqlFiles            main's SQL file names
 * @param {string[]} p.workSqlFiles            working-tree SQL file names
 * @param {object[]} p.workEntries             working journal entries (tolerant parse)
 * @returns {{ renames: {from: string, to: string}[], newEntries: object[],
 *             orphans: string[], journal: object }}
 */
export function planRenumber({ baseJournal, baseSqlFiles, workSqlFiles, workEntries }) {
  const baseFiles = new Set(baseSqlFiles);
  const baseEntries = baseJournal.entries ?? [];
  const workByTag = new Map(workEntries.map((e, i) => [e.tag, { e, i }]));

  const added = workSqlFiles.filter((f) => !baseFiles.has(f)).map((f) => f.replace(/\.sql$/, ''));
  const orphans = added.filter((tag) => !workByTag.has(tag));
  const branch = added
    .filter((tag) => workByTag.has(tag))
    .sort((a, b) => workByTag.get(a).i - workByTag.get(b).i);

  const numbers = [...baseSqlFiles, ...baseEntries.map((e) => e.tag)]
    .map(migrationNumber)
    .filter((n) => n !== null);
  let next = (numbers.length ? Math.max(...numbers) : -1) + 1;
  let maxWhen = Math.max(0, ...baseEntries.map((e) => Number(e.when) || 0));

  const renames = [];
  const newEntries = branch.map((tag, i) => {
    const orig = workByTag.get(tag).e;
    const n = migrationNumber(tag);
    const num = n === null || n < next ? next : n;
    const newTag = withNumber(tag, num);
    if (newTag !== tag) renames.push({ from: tag, to: newTag });
    next = num + 1;
    const when = Number(orig.when) > maxWhen ? Number(orig.when) : maxWhen + DAY_MS;
    maxWhen = when;
    return {
      idx: baseEntries.length + i,
      version: orig.version ?? '7',
      when,
      tag: newTag,
      breakpoints: orig.breakpoints ?? true,
    };
  });

  const { entries: _ignored, ...head } = baseJournal;
  return { renames, newEntries, orphans, journal: { ...head, entries: [...baseEntries, ...newEntries] } };
}

export function serializeJournal(journal) {
  return `${JSON.stringify(journal, null, '\t')}\n`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------- CLI ----

function parseArgs(argv) {
  const opts = { base: null, dir: DEFAULT_DIR, applied: process.env.FEASLY_APPLIED_MIGRATIONS || null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--applied') opts.applied = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const log = (msg) => console.log(`renumber-migrations: ${msg}`);
  const git = (args, opts = {}) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tryGit = (args) => {
    try {
      return git(args);
    } catch {
      return null;
    }
  };

  const opts = parseArgs(argv);
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const dirAbs = resolve(cwd, opts.dir);
  const dir = relative(root, dirAbs).split('\\').join('/');
  const journalRel = `${dir}/meta/_journal.json`;
  const journalAbs = join(root, journalRel);
  const gitRoot = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  // ---- base ref
  const exists = (ref) => tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
  let base = opts.base;
  if (!base) base = ['MERGE_HEAD', 'origin/main', 'main'].find(exists) ?? null;
  if (!base || !exists(base)) {
    log(`no base ref found (${opts.base ?? 'MERGE_HEAD/origin/main/main'}) — skipped`);
    return 0;
  }
  if (base !== 'MERGE_HEAD' && tryGit(['merge-base', '--is-ancestor', base, 'HEAD']) === null) {
    const mb = tryGit(['merge-base', base, 'HEAD'])?.trim();
    if (!mb) {
      log(`${base} shares no history with HEAD — skipped`);
      return 0;
    }
    log(`note: ${base} is not merged into this branch yet; checking against the last merged main (${mb.slice(0, 8)}). Merge ${base} and re-run to catch new collisions.`);
    base = mb;
  }

  const baseJournalText = tryGit(['show', `${base}:${journalRel}`]);
  if (baseJournalText === null || !existsSync(journalAbs)) {
    log(`no ${journalRel} on ${base} or in the working tree — skipped`);
    return 0;
  }
  const baseJournal = JSON.parse(baseJournalText);
  const baseSqlFiles = git(['ls-tree', '--name-only', base, '--', `${dir}/`])
    .split('\n')
    .map((p) => p.trim().split('/').pop())
    .filter((f) => f && f.endsWith('.sql'));
  const workSqlFiles = readdirSync(dirAbs).filter((f) => f.endsWith('.sql')).sort();
  const workText = readFileSync(journalAbs, 'utf8');
  const conflicted = hasConflictMarkers(workText);
  const workEntries = parseJournalEntries(workText);

  const plan = planRenumber({ baseJournal, baseSqlFiles, workSqlFiles, workEntries });
  for (const o of plan.orphans) {
    log(`warning: ${dir}/${o}.sql has no _journal.json entry — left alone (drizzle-kit will never apply it)`);
  }

  // ---- already-applied guard (only migrations we would rename matter)
  if (plan.renames.length) {
    const baseTags = new Set((baseJournal.entries ?? []).map((e) => e.tag));
    const baseHashes = new Map();
    for (const f of baseSqlFiles) {
      const text = tryGit(['show', `${base}:${dir}/${f}`]);
      if (text !== null) baseHashes.set(sha256(text), f);
    }
    const applied = new Set();
    if (opts.applied) {
      for (const line of readFileSync(resolve(cwd, opts.applied), 'utf8').split('\n')) {
        const v = line.trim();
        if (v && !v.startsWith('#')) applied.add(v);
      }
    }
    const problems = [];
    for (const { from } of plan.renames) {
      const hash = sha256(readFileSync(join(dirAbs, `${from}.sql`), 'utf8'));
      if (baseTags.has(from)) problems.push(`${from} is already in ${base}'s journal (merged ⇒ deployed)`);
      else if (baseHashes.has(hash)) problems.push(`${from} is byte-identical to ${base}'s ${baseHashes.get(hash)} (drizzle tracks by hash: already applied)`);
      else if (applied.has(from) || applied.has(hash)) problems.push(`${from} is in the applied list ${opts.applied}`);
    }
    if (problems.length) {
      console.error('renumber-migrations: FAIL — refusing to renumber a migration that was already applied:');
      for (const p of problems) console.error(`  - ${p}`);
      console.error('Resolve by hand: an applied migration must never be renamed or re-numbered.');
      return 1;
    }
  }

  if (!plan.renames.length && !conflicted) {
    log('no colliding migrations — nothing to do');
    return 0;
  }

  for (const { from, to } of plan.renames) log(`${from} → ${to}`);
  if (conflicted) log(`resolving the ${journalRel} conflict: ${base}'s entries + this branch's appended`);
  if (opts.dryRun) {
    log('dry run — no files changed');
    return 0;
  }

  const tracked = (rel) => tryGit(['ls-files', '--error-unmatch', '--', rel]) !== null;
  const unmerged = (rel) => (tryGit(['ls-files', '-u', '--', rel]) ?? '').trim() !== '';
  const baseHas = (rel) => tryGit(['cat-file', '-e', `${base}:${rel}`]) !== null;
  const move = (fromRel, toRel) => {
    if (existsSync(join(root, toRel))) throw new Error(`refusing to overwrite ${toRel}`);
    if (tracked(fromRel)) gitRoot(['mv', fromRel, toRel]);
    else renameSync(join(root, fromRel), join(root, toRel));
  };

  for (const { from, to } of plan.renames) {
    move(`${dir}/${from}.sql`, `${dir}/${to}.sql`);
    const oldNum = from.split('_')[0];
    const newNum = to.split('_')[0];
    const snapFrom = `${dir}/meta/${oldNum}_snapshot.json`;
    const snapTo = `${dir}/meta/${newNum}_snapshot.json`;
    if (unmerged(snapFrom)) {
      // add/add conflict on the snapshot: ours (stage 2) is the branch's, theirs (stage 3) main's.
      const ours = tryGit(['show', `:2:${snapFrom}`]);
      const theirs = tryGit(['show', `:3:${snapFrom}`]);
      if (ours === null || theirs === null) throw new Error(`cannot split conflicted ${snapFrom}; resolve it by hand`);
      writeFileSync(join(root, snapTo), ours);
      writeFileSync(join(root, snapFrom), theirs);
      gitRoot(['add', '--', snapFrom, snapTo]);
      log(`${snapFrom} conflict split → ${snapTo}`);
    } else if (existsSync(join(root, snapFrom)) && !baseHas(snapFrom)) {
      move(snapFrom, snapTo);
    }
  }
  const wasUnmerged = unmerged(journalRel);
  writeFileSync(journalAbs, serializeJournal(plan.journal));
  if (wasUnmerged || tracked(journalRel)) gitRoot(['add', '--', journalRel]);

  for (const { from } of plan.renames) {
    const refs = (tryGit(['grep', '-l', '-F', from, '--', '.', `:!${dir}`]) ?? '').trim();
    if (refs) log(`warning: files still mention ${from} — update them: ${refs.split('\n').join(', ')}`);
  }
  log(`done — ${plan.renames.length} renamed; review and commit the staged changes`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`renumber-migrations: FAIL — ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
