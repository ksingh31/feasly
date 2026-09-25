/**
 * Generate the bundled builder-config module from `config/builders/*.json`.
 *
 * Why codegen: the Azure Functions bundle is self-contained (no files on
 * disk at runtime), so the repo JSON is validated and inlined at build
 * time. An invalid config fails the build — a deploy-time failure, never a
 * silently broken embed (EMB-02).
 *
 * Reads every `config/builders/*.json` (except dotfiles), validates with
 * the canonical zod schema in
 * `src/services/builder-config/builder-config.schema.ts`, and writes
 * `src/generated/builder-configs.ts` (gitignored).
 *
 * Runs automatically before build/test/bundle via the `prebuild`,
 * `pretest`, and `prebundle:functions` npm hooks. `NODE_ENV=development`
 * is what permits http localhost origins; anything else requires https.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateBuilderConfigs,
  type BuilderConfigFile,
} from '../src/services/builder-config/builder-config.schema';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(toolsDir, '..', '..', '..');
const buildersDir = join(repoRoot, 'config', 'builders');
const outDir = join(repoRoot, 'apps', 'api', 'src', 'generated');
const outFile = join(outDir, 'builder-configs.ts');

function main(): void {
  const files = readdirSync(buildersDir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort();
  if (files.length === 0) {
    console.warn(
      `generate-builder-configs: no configs found in ${buildersDir} — the embed config endpoint will 404 every key until one is added`,
    );
  }
  const sources = files.map((file) => {
    const raw = readFileSync(join(buildersDir, file), 'utf8');
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`invalid builder config "${file}": not valid JSON`);
    }
    return { file, data };
  });

  const isDev = process.env.NODE_ENV === 'development';
  const configs = validateBuilderConfigs(sources, { isDev });

  mkdirSync(outDir, { recursive: true });
  const body = [
    '/**',
    ' * GENERATED — do not edit by hand. Source: config/builders/*.json.',
    ' * Regenerate: npm run build:configs --workspace @feasly/api',
    ' * (also runs automatically via prebuild / pretest / prebundle:functions).',
    ' */',
    "import type { BuilderConfigFile } from '../services/builder-config/builder-config.schema';",
    '',
    'export const BUILDER_CONFIGS: Record<string, BuilderConfigFile> =',
    `  ${JSON.stringify(configs, null, 2)} as Record<string, BuilderConfigFile>;`,
    '',
  ].join('\n');
  writeFileSync(outFile, body);
  const keys = Object.keys(configs);
  console.log(
    `generate-builder-configs: wrote ${outFile} with ${keys.length} tenant(s): ${keys.join(', ') || '(none)'}`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `generate-builder-configs: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
