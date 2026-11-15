/**
 * #758 spec: personal-identifier guard (tools/check-personal-ids.mjs).
 *
 * Proves the guard bites on a seeded identifier (via an injected denylist,
 * so this spec publishes nothing real), honours the hash-keyed allowlist,
 * scans tests and docs too, and that the committed denylist holds hashes
 * only.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DENYLIST_SHA256,
  HASH_PREFIX_LEN,
  checkPersonalIds,
  sha256,
} from '../../../tools/check-personal-ids.mjs';

const SEEDED_EMAIL = 'jane.personal@mail.test';
const SEEDED_GUID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const DENY = [sha256(SEEDED_EMAIL), sha256(SEEDED_GUID)];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'personal-ids-'));
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools', 'personal-id-allowlist.txt'), '# empty\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('checkPersonalIds', () => {
  it('passes on a clean tree', () => {
    write('docs/a.md', 'Contact the owner at ops@feasly.example.\n');
    write('apps/api/test/a.test.ts', `const id = '11111111-1111-4111-8111-111111111111';\n`);
    expect(checkPersonalIds(root, DENY)).toEqual([]);
  });

  it('fails on a seeded email — case-insensitive, without echoing it', () => {
    write('docs/runbook.md', `Mail \`${SEEDED_EMAIL.toUpperCase()}\` for access.\n`);
    const failures = checkPersonalIds(root, DENY);
    expect(failures).toEqual([
      `docs/runbook.md:1 [personal id ${DENY[0].slice(0, HASH_PREFIX_LEN)}]`,
    ]);
    expect(failures.join('\n')).not.toContain('jane');
  });

  it('fails on a seeded GUID in any file type, tests included', () => {
    write('apps/api/test/x.test.ts', `const sub = '${SEEDED_GUID}';\n`);
    write('infra/bicep/main.bicep', `// subscription (${SEEDED_GUID})\n`);
    write('CLAUDE.md', `- Subscription \`${SEEDED_GUID}\`\n`);
    expect(checkPersonalIds(root, DENY)).toHaveLength(3);
  });

  it('passes an allowlisted file + hash, and only that pair', () => {
    const prefix = DENY[0].slice(0, HASH_PREFIX_LEN);
    write(
      'tools/personal-id-allowlist.txt',
      `apps/api/src/db/migrations/0001_seed.sql :: ${prefix} :: applied migration seed\n`,
    );
    write('apps/api/src/db/migrations/0001_seed.sql', `INSERT ... VALUES ('${SEEDED_EMAIL}');\n`);
    expect(checkPersonalIds(root, DENY)).toEqual([]);

    // Same file, different identifier → still fails.
    write(
      'apps/api/src/db/migrations/0001_seed.sql',
      `INSERT ... VALUES ('${SEEDED_EMAIL}', '${SEEDED_GUID}');\n`,
    );
    expect(checkPersonalIds(root, DENY)).toHaveLength(1);

    // Same identifier, other file → fails (exact path, not substring).
    write('apps/api/src/db/migrations/0001_seed.sql.bak', `'${SEEDED_EMAIL}'\n`);
    expect(checkPersonalIds(root, DENY)).toHaveLength(2);
  });

  it('rejects an allowlist entry without a reason', () => {
    write('tools/personal-id-allowlist.txt', 'docs/a.md :: abcdef123456\n');
    expect(() => checkPersonalIds(root, DENY)).toThrow(/malformed/);
  });

  it('skips node_modules and binary files', () => {
    write('node_modules/pkg/index.js', `'${SEEDED_EMAIL}'\n`);
    writeFileSync(join(root, 'img.png'), Buffer.concat([Buffer.from([0]), Buffer.from(SEEDED_EMAIL)]));
    expect(checkPersonalIds(root, DENY)).toEqual([]);
  });
});

describe('DENYLIST_SHA256', () => {
  it('stores hashes only, never plaintext identifiers', () => {
    expect(DENYLIST_SHA256.length).toBeGreaterThan(0);
    for (const h of DENYLIST_SHA256) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
