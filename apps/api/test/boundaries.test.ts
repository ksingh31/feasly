/**
 * Layer-boundary enforcement (BE0-001).
 *
 * The layered pattern is law, not convention. These tests scan the source
 * tree and fail the PR if:
 *  1. anything under src/routes/ or src/middleware/ imports from src/db/
 *     (only services/ and composition.ts may touch the database), or
 *  2. anything outside src/config.ts reads process.env directly
 *     (all tunables flow through typed config).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...allTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function underDir(file: string, dir: string): boolean {
  return relative(join(SRC, dir), file).split(sep)[0] !== '..';
}

/** Strip // and /* *\/ comments so prose can't trip the scanners. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const IMPORT_FROM_RE =
  /(?:import|export)\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Import specifiers in `file` that resolve into the db/ layer. */
function dbImports(file: string): string[] {
  const code = stripComments(readFileSync(file, 'utf8'));
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_FROM_RE.lastIndex = 0;
  while ((m = IMPORT_FROM_RE.exec(code)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec.split('/').includes('db')) hits.push(spec);
  }
  return hits;
}

function readsProcessEnv(file: string): boolean {
  const code = stripComments(readFileSync(file, 'utf8'));
  return /process\.env\b/.test(code);
}

describe('layer boundaries', () => {
  const files = allTsFiles(SRC);

  it('routes/ and middleware/ never import from db/', () => {
    const violations = files
      .filter((f) => underDir(f, 'routes') || underDir(f, 'middleware'))
      .flatMap((f) => dbImports(f).map((spec) => `${relative(SRC, f)} -> ${spec}`));
    expect(violations).toEqual([]);
  });

  it('only config.ts reads process.env directly', () => {
    const violations = files
      .filter((f) => relative(SRC, f) !== 'config.ts')
      .filter(readsProcessEnv)
      .map((f) => relative(SRC, f));
    expect(violations).toEqual([]);
  });

  it('config.ts is the single env reader (guard against the rule being vacuous)', () => {
    expect(readsProcessEnv(join(SRC, 'config.ts'))).toBe(true);
  });
});
