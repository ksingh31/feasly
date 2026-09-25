/**
 * HRD-05 spec: placeholder sweep (tools/check-placeholders.mjs).
 *
 * Proves the sweep bites: unallowlisted placeholders fail, allowlisted ones
 * pass, and test files are always excluded.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPlaceholders, isExcluded } from '../../../tools/check-placeholders.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'placeholders-'));
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools', 'placeholder-allowlist.txt'), '# empty\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('checkPlaceholders', () => {
  it('passes on a clean tree', () => {
    write('apps/web/src/a.ts', `const x = 'hello';\n`);
    expect(checkPlaceholders(root)).toEqual([]);
  });

  it('fails on an unallowlisted PLACEHOLDER', () => {
    write('apps/web/src/a.ts', `const url = 'https://PLACEHOLDER.example';\n`);
    const failures = checkPlaceholders(root);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('[PLACEHOLDER]');
  });

  it('fails on TODO(launch)', () => {
    write('apps/api/src/b.ts', `// TODO(launch): remove before launch\n`);
    expect(checkPlaceholders(root).length).toBe(1);
  });

  it('fails on the test email in a production path', () => {
    write('apps/api/src/c.ts', `const inbox = 'karanbirsingh667@gmail.com';\n`);
    const failures = checkPlaceholders(root);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('[test email]');
  });

  it('passes an allowlisted placeholder', () => {
    write(
      'tools/placeholder-allowlist.txt',
      'apps/api/src/c.ts :: test email :: standing test email until Karan names the inbox\n',
    );
    write('apps/api/src/c.ts', `const inbox = 'karanbirsingh667@gmail.com';\n`);
    expect(checkPlaceholders(root)).toEqual([]);
  });

  it('always excludes test files', () => {
    write('apps/api/test/c.test.ts', `const inbox = 'karanbirsingh667@gmail.com';\n`);
    expect(checkPlaceholders(root)).toEqual([]);
  });
});

describe('isExcluded', () => {
  it('excludes specs, tests, seeds, generated, and plan docs', () => {
    expect(isExcluded('apps/web/src/a.spec.ts')).toBe(true);
    expect(isExcluded('apps/api/test/a.test.ts')).toBe(true);
    expect(isExcluded('apps/api/src/seed.ts')).toBe(true);
    expect(isExcluded('apps/api/src/generated/x.ts')).toBe(true);
    expect(isExcluded('plan/stories/x.md')).toBe(true);
    expect(isExcluded('tools/check-placeholders.mjs')).toBe(true);
  });

  it('includes production code', () => {
    expect(isExcluded('apps/web/src/a.ts')).toBe(false);
    expect(isExcluded('apps/api/src/config.ts')).toBe(false);
  });
});
