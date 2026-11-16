#!/usr/bin/env node
/**
 * check-openapi-breaking.mjs — OpenAPI breaking-change guard (#765, go-live AC4).
 *
 * Diffs the published OpenAPI spec (generated from the zod schemas) against
 * the spec of the last release (`tools/openapi-baseline.json`) and fails
 * when a change would break an existing client, unless the API version is
 * bumped (major; or minor while the major is 0 — semver's 0.x rule).
 *
 * Usage:
 *   node tools/check-openapi-breaking.mjs --base <baseline.json> --head <spec.json> [--head-version <v>]
 *   node tools/check-openapi-breaking.mjs --head <spec.json> --head-version <v> --write-baseline <out.json>
 *
 * `npm run openapi:breaking --workspace @feasly/api` emits the current spec
 * and runs this against the committed baseline with the api package
 * version; the api `lint` script runs it, so CI runs it too.
 *
 * Cutting a release: bump `apps/api/package.json` version if the release
 * is breaking, then refresh the baseline with
 * `npm run openapi:baseline --workspace @feasly/api` and commit it.
 *
 * What counts as breaking (a pragmatic subset of the usual oasdiff rules):
 *   - a path or operation is removed
 *   - a new required parameter, or an optional parameter becomes required
 *   - a request body becomes required, or a request media type is removed
 *   - request schemas narrow: a new required property, a removed type or
 *     enum value, a new enum, tightened min/max limits, a removed property
 *     when additionalProperties is false
 *   - a success (2xx) response or its media type is removed
 *   - response schemas change shape: a removed property, a required
 *     property becoming optional, a widened type (e.g. a field becomes
 *     nullable)
 *   - security requirements of an operation change
 * Additive changes (new paths, operations, optional parameters, optional
 * request properties, new response properties) pass.
 *
 * Pure functions are exported for tools/check-openapi-breaking.test.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const TIGHTEN_UP = ['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties'];
const TIGHTEN_DOWN = ['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties'];

/** Resolve a local `#/components/...` $ref (one level at a time, cycle-safe). */
function resolve(spec, schema) {
  let current = schema;
  const seen = new Set();
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return current;
    seen.add(current.$ref);
    const ref = current.$ref;
    if (!ref.startsWith('#/')) return current;
    let target = spec;
    for (const part of ref.slice(2).split('/')) {
      target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    current = target;
  }
  return current ?? {};
}

/** The set of JSON types a schema admits (null included via `nullable`). */
function typesOf(schema) {
  const out = new Set();
  if (Array.isArray(schema.type)) schema.type.forEach((t) => out.add(t));
  else if (typeof schema.type === 'string') out.add(schema.type);
  if (schema.nullable === true) out.add('null');
  return out;
}

function typeSubset(a, b) {
  for (const t of a) {
    // integer ⊂ number
    if (t === 'integer' && b.has('number')) continue;
    if (!b.has(t)) return false;
  }
  return true;
}

/**
 * Compare two schemas. `direction` is 'request' (head must accept
 * everything base accepted) or 'response' (head must not send anything a
 * base client could not read).
 */
function compareSchema(ctx, baseRaw, headRaw, direction, where, seen = new Set()) {
  const base = resolve(ctx.base, baseRaw);
  const head = resolve(ctx.head, headRaw);
  const key = `${baseRaw?.$ref ?? ''}|${headRaw?.$ref ?? ''}|${direction}`;
  if ((baseRaw?.$ref || headRaw?.$ref) && seen.has(key)) return;
  const nextSeen = new Set(seen).add(key);

  // Types.
  const bt = typesOf(base);
  const ht = typesOf(head);
  if (bt.size > 0 && ht.size > 0) {
    if (direction === 'request' && !typeSubset(bt, ht)) {
      ctx.out.push(`${where}: request type narrowed from ${[...bt].join('|')} to ${[...ht].join('|')}`);
    }
    if (direction === 'response' && !typeSubset(ht, bt)) {
      ctx.out.push(`${where}: response type widened from ${[...bt].join('|')} to ${[...ht].join('|')}`);
    }
  }

  // Enums.
  if (direction === 'request') {
    if (Array.isArray(head.enum) && !Array.isArray(base.enum)) {
      ctx.out.push(`${where}: request now restricted to an enum`);
    } else if (Array.isArray(head.enum) && Array.isArray(base.enum)) {
      const removed = base.enum.filter((v) => !head.enum.some((h) => JSON.stringify(h) === JSON.stringify(v)));
      if (removed.length) ctx.out.push(`${where}: request enum value(s) removed: ${removed.map((v) => JSON.stringify(v)).join(', ')}`);
    }
    for (const k of TIGHTEN_UP) {
      if (typeof head[k] === 'number' && (typeof base[k] !== 'number' || head[k] > base[k])) {
        ctx.out.push(`${where}: request ${k} tightened (${base[k] ?? 'none'} → ${head[k]})`);
      }
    }
    for (const k of TIGHTEN_DOWN) {
      if (typeof head[k] === 'number' && (typeof base[k] !== 'number' || head[k] < base[k])) {
        ctx.out.push(`${where}: request ${k} tightened (${base[k] ?? 'none'} → ${head[k]})`);
      }
    }
  }

  // Object properties.
  const bp = base.properties ?? {};
  const hp = head.properties ?? {};
  const breq = new Set(base.required ?? []);
  const hreq = new Set(head.required ?? []);
  for (const name of Object.keys(bp)) {
    const at = `${where}.${name}`;
    if (!(name in hp)) {
      if (direction === 'response') ctx.out.push(`${at}: response property removed`);
      else if (head.additionalProperties === false) ctx.out.push(`${at}: request property removed (additionalProperties: false)`);
      continue;
    }
    compareSchema(ctx, bp[name], hp[name], direction, at, nextSeen);
  }
  if (direction === 'request') {
    for (const name of hreq) {
      if (!breq.has(name)) ctx.out.push(`${where}.${name}: request property is now required`);
    }
  } else {
    for (const name of breq) {
      if (name in hp && !hreq.has(name)) ctx.out.push(`${where}.${name}: response property no longer required`);
    }
  }

  // Arrays.
  if (base.items && head.items) {
    compareSchema(ctx, base.items, head.items, direction, `${where}[]`, nextSeen);
  }

  // Compositions — compared positionally when the shape is unchanged.
  for (const kind of ['oneOf', 'anyOf', 'allOf']) {
    const b = base[kind];
    const h = head[kind];
    if (!Array.isArray(b) && !Array.isArray(h)) continue;
    if (!Array.isArray(b) || !Array.isArray(h)) {
      ctx.out.push(`${where}: ${kind} composition added or removed`);
      continue;
    }
    if (h.length !== b.length) {
      // Only a request oneOf/anyOf may grow (it then accepts more shapes).
      const additive = kind !== 'allOf' && direction === 'request' && h.length > b.length;
      if (!additive) {
        ctx.out.push(`${where}: ${direction} ${kind} branches changed (${b.length} → ${h.length})`);
        continue;
      }
    }
    for (let i = 0; i < b.length; i += 1) {
      compareSchema(ctx, b[i], h[i], direction, `${where}<${kind}[${i}]>`, nextSeen);
    }
  }
}

function paramKey(p) {
  return `${p.in}:${p.name}`;
}

function compareOperation(ctx, baseOp, headOp, where) {
  // Parameters (path-level params merged by the caller).
  const bParams = new Map((baseOp.parameters ?? []).map((p) => {
    const r = resolve(ctx.base, p);
    return [paramKey(r), r];
  }));
  for (const raw of headOp.parameters ?? []) {
    const hp = resolve(ctx.head, raw);
    const bpar = bParams.get(paramKey(hp));
    if (!bpar) {
      if (hp.required) ctx.out.push(`${where}: new required ${hp.in} parameter "${hp.name}"`);
      continue;
    }
    if (hp.required && !bpar.required) {
      ctx.out.push(`${where}: ${hp.in} parameter "${hp.name}" became required`);
    }
    if (bpar.schema && hp.schema) {
      compareSchema(ctx, bpar.schema, hp.schema, 'request', `${where} ${hp.in}:${hp.name}`);
    }
  }

  // Request body.
  const bBody = baseOp.requestBody ? resolve(ctx.base, baseOp.requestBody) : null;
  const hBody = headOp.requestBody ? resolve(ctx.head, headOp.requestBody) : null;
  if (hBody?.required && !bBody?.required) {
    ctx.out.push(`${where}: request body became required`);
  }
  if (bBody && hBody) {
    for (const [media, bm] of Object.entries(bBody.content ?? {})) {
      const hm = hBody.content?.[media];
      if (!hm) {
        ctx.out.push(`${where}: request media type ${media} removed`);
        continue;
      }
      if (bm.schema && hm.schema) {
        compareSchema(ctx, bm.schema, hm.schema, 'request', `${where} body`);
      }
    }
  }

  // Success responses.
  for (const [code, braw] of Object.entries(baseOp.responses ?? {})) {
    if (!/^2/.test(code)) continue;
    const hraw = headOp.responses?.[code];
    if (!hraw) {
      ctx.out.push(`${where}: ${code} response removed`);
      continue;
    }
    const br = resolve(ctx.base, braw);
    const hr = resolve(ctx.head, hraw);
    for (const [media, bm] of Object.entries(br.content ?? {})) {
      const hm = hr.content?.[media];
      if (!hm) {
        ctx.out.push(`${where}: ${code} response media type ${media} removed`);
        continue;
      }
      if (bm.schema && hm.schema) {
        compareSchema(ctx, bm.schema, hm.schema, 'response', `${where} ${code}`);
      }
    }
  }

  // Security.
  const bSec = JSON.stringify(baseOp.security ?? ctx.base.security ?? []);
  const hSec = JSON.stringify(headOp.security ?? ctx.head.security ?? []);
  if (bSec !== hSec) {
    ctx.out.push(`${where}: security requirements changed (${bSec} → ${hSec})`);
  }
}

/**
 * List breaking changes from `base` to `head` (both OpenAPI 3.x documents).
 * Returns human-readable strings; empty means no breaking change.
 */
export function findBreakingChanges(base, head) {
  const ctx = { base, head, out: [] };
  for (const [path, bItem] of Object.entries(base.paths ?? {})) {
    const hItem = head.paths?.[path];
    if (!hItem) {
      ctx.out.push(`${path}: path removed`);
      continue;
    }
    for (const method of METHODS) {
      const bOp = bItem[method];
      if (!bOp) continue;
      const hOp = hItem[method];
      const where = `${method.toUpperCase()} ${path}`;
      if (!hOp) {
        ctx.out.push(`${where}: operation removed`);
        continue;
      }
      const merge = (item, op) => ({
        ...op,
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
      });
      compareOperation(ctx, merge(bItem, bOp), merge(hItem, hOp), where);
    }
  }
  return ctx.out;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * True when `headVersion` is a breaking-change bump over `baseVersion`:
 * a higher major, or (semver 0.x) a higher minor while the major is 0.
 */
export function isBreakingBump(baseVersion, headVersion) {
  const b = parseVersion(baseVersion);
  const h = parseVersion(headVersion);
  if (!b || !h) return false;
  if (h[0] > b[0]) return true;
  return b[0] === 0 && h[0] === 0 && h[1] > b[1];
}

/**
 * The full check: { ok, breaking, bumped, baseVersion, headVersion }.
 */
export function checkOpenApiCompat(base, head, headVersion = head?.info?.version) {
  const breaking = findBreakingChanges(base, head);
  const baseVersion = base?.info?.version;
  const bumped = isBreakingBump(baseVersion, headVersion);
  return { ok: breaking.length === 0 || bumped, breaking, bumped, baseVersion, headVersion };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const headPath = argValue(argv, '--head');
  const basePath = argValue(argv, '--base');
  const headVersionArg = argValue(argv, '--head-version');
  const writeBaseline = argValue(argv, '--write-baseline');
  if (!headPath) {
    console.error('usage: check-openapi-breaking.mjs --base <baseline.json> --head <spec.json> [--head-version <v>]');
    return 2;
  }
  const head = JSON.parse(readFileSync(headPath, 'utf8'));
  const headVersion = headVersionArg ?? head.info?.version;

  if (writeBaseline) {
    const baseline = { ...head, info: { ...head.info, version: headVersion } };
    writeFileSync(writeBaseline, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`openapi baseline written to ${writeBaseline} (version ${headVersion})`);
    return 0;
  }
  if (!basePath) {
    console.error('check-openapi-breaking: --base is required');
    return 2;
  }
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const result = checkOpenApiCompat(base, head, headVersion);
  if (result.breaking.length === 0) {
    console.log(`OpenAPI breaking-change check: no breaking changes vs baseline ${result.baseVersion}. OK.`);
    return 0;
  }
  const list = result.breaking.map((b) => `  - ${b}`).join('\n');
  if (result.bumped) {
    console.log(
      `OpenAPI breaking-change check: ${result.breaking.length} breaking change(s), allowed by the version bump ${result.baseVersion} → ${result.headVersion}:\n${list}\n` +
        'Refresh the baseline when this ships: npm run openapi:baseline --workspace @feasly/api',
    );
    return 0;
  }
  console.error(
    `OPENAPI BREAKING-CHANGE CHECK FAILED (${result.breaking.length}) — baseline ${result.baseVersion}, current ${result.headVersion}:\n${list}\n` +
      'Make the change additive, or bump the apps/api package version (major; minor while 0.x) and ship it as a new API version.',
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
