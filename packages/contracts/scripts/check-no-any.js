/**
 * check-no-any: forbids the `any` type in @feasly/contracts (`npm run lint`).
 * Contracts are the frozen seam between UI and backend — `any` would let shapes
 * drift silently, defeating the whole contracts-first approach. Run in CI.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const PATTERNS = [': any', '<any>', 'as any', 'any[]', ':any'];

function stripCommentsAndStrings(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

let failures = 0;
for (const file of walk(SRC)) {
  const clean = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
  clean.split('\n').forEach((line, i) => {
    for (const p of PATTERNS) {
      // Word-boundary-ish check so words like "company" don't match.
      const idx = line.indexOf(p);
      if (idx !== -1 && (p !== ': any' || /:\s+any\b/.test(line))) {
        console.error(`${path.relative(SRC, file)}:${i + 1}: forbidden 'any' usage (${p.trim()})`);
        failures++;
        break;
      }
    }
  });
}

if (failures > 0) {
  console.error(`\ncheck-no-any: ${failures} violation(s). Use precise types — contracts must be exact.`);
  process.exit(1);
}
console.log('check-no-any: clean.');
