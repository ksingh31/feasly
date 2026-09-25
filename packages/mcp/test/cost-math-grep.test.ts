/**
 * Cost-math grep test (api-mcp/06 acceptance criteria #5).
 *
 * The MCP package is a thin wrapper — it must contain zero cost-math of
 * its own. This test fails if cost-engine internals leak into the package.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../src');

// Banned patterns: cost-engine internals that must not appear in the MCP
// package. The engine lives in @feasly/cost-engine; the MCP server calls
// it via EstimateService, never directly.
const BANNED_PATTERNS: RegExp[] = [
  /per_sqft/i,
  /perSqft/i,
  /\bBASE_RATE\b/,
  /\bTIER_MULTIPLIER\b/,
  /costPerSqft/i,
  /band.*low.*base.*high/i,
];

function getSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getSourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('zero cost-math in the MCP package', () => {
  it('no banned cost-engine patterns in src/', () => {
    const files = getSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file}: matches ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
