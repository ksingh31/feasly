// #574 — the nightly ops review (agent-ops.yml) logs in as the CI OIDC
// identity and runs `az consumption budget list` against the
// subscription-scoped `feasly-monthly-cap` budget. That needs Cost Management
// Reader at SUBSCRIPTION scope. The module stays in Bicep, but #637: the CD
// OIDC identity is RG-scoped and cannot write subscription-scope deployments
// or role assignments, so enabling the grant fails what-if and the whole CD
// deploy. It must stay gated OFF by default and in every environment; the
// role is granted once, by hand, by a subscription Owner.
// Static, no-auth guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const COST_MANAGEMENT_READER = '72fafb9e-0641-4937-9268-a91bfd8191a3';

test('cost-reader module targets the subscription and uses Cost Management Reader', () => {
  const mod = read('infra/bicep/modules/subscription-cost-reader.bicep');
  assert.match(mod, /^targetScope = 'subscription'$/m);
  assert.match(mod, /resource \w+ 'Microsoft\.Authorization\/roleAssignments@[\d-]+'/);
  assert.ok(mod.includes(COST_MANAGEMENT_READER), 'Cost Management Reader role id');
  // Read-only role only: no Contributor/Owner/User Access Administrator ids.
  for (const id of [
    'b24988ac-6180-42a0-ab88-20f7382dd24c', // Contributor
    '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', // Owner
    '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9', // User Access Administrator
    '434105ed-43f6-45c7-a02f-909b2ba83430', // Cost Management Contributor
  ]) assert.ok(!mod.includes(id), `must not grant ${id}`);
  // Name is stable per principal+subscription so re-deploys are idempotent.
  assert.match(mod, /name: guid\(subscription\(\)\.id, costManagementReaderRoleId, principalId\)/);
});

test('main.bicep wires the module at subscription scope for the deployer identity', () => {
  const main = read('infra/bicep/main.bicep');
  const m = main.match(
    /module \w+ 'modules\/subscription-cost-reader\.bicep' = if \(grantDeployerCostReader\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(m, 'module declaration present');
  assert.match(m[1], /scope: subscription\(\)/);
  assert.match(m[1], /principalId: deployer\(\)\.objectId/);
});

test('#637: the subscription-scope grant is gated off by default', () => {
  assert.match(read('infra/bicep/main.bicep'), /^param grantDeployerCostReader bool = false$/m);
});

test('#637: no environment turns the grant on (CD identity is RG-scoped)', () => {
  const dir = 'infra/bicep/environments/';
  const files = readdirSync(root + dir).filter((f) => f.endsWith('.bicepparam'));
  assert.ok(files.includes('dev.bicepparam'), 'dev.bicepparam present');
  for (const f of files) {
    const src = read(dir + f);
    assert.doesNotMatch(src, /^param grantDeployerCostReader\s*=\s*true\b/m, `${f} must not enable the grant`);
  }
  assert.match(read(dir + 'dev.bicepparam'), /^param grantDeployerCostReader = false$/m);
});
