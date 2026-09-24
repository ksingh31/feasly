/**
 * Engine purity scan — the determinism invariants, enforced in code.
 * The engine source must never touch the clock, randomness, the
 * environment, the network, or the filesystem.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

/** Strip // and /* *\/ comments so prose can't trip the scanner. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const BANNED = [
  /Date\.now\s*\(/,
  /Math\.random\s*\(/,
  /process\.env\b/,
  /process\.argv\b/,
  /\bfetch\s*\(/,
  /require\s*\(\s*['"]node:/,
  /from\s+['"]node:fs['"]/,
  /from\s+['"]node:process['"]/,
];

describe('engine purity', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  it('scans every engine source file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} has no I/O, clock, randomness, env or network access`, () => {
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
      for (const pattern of BANNED) {
        expect(code).not.toMatch(pattern);
      }
    });
  }
});
