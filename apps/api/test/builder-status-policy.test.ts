/**
 * #860 AC6 — the builder status policy matrix, table-driven. This table IS
 * the documented matrix (see #860 / lib/builder-status-policy.ts); a change
 * to the policy must change this table on purpose.
 */
import { describe, expect, it } from 'vitest';
import type { BuilderCapability, BuilderStatus } from '@feasly/contracts';
import {
  builderPausedError,
  builderStatusAllows,
  normalizeBuilderStatus,
  requireBuilderCapability,
} from '../src/lib/builder-status-policy';

//                 embed  newLeads signIn portalRead portalWrite viewInv payInv autoCharge apiKeys
const MATRIX: Record<BuilderStatus, readonly boolean[]> = {
  active:      [true,  true,  true,  true,  true,  true,  true, true,  true],
  suspended:   [false, false, true,  true,  false, true,  true, false, false],
  offboarding: [false, false, true,  true,  true,  true,  true, true,  false],
  offboarded:  [false, false, false, false, false, false, true, false, false],
};
const CAPABILITIES: readonly BuilderCapability[] = [
  'embed', 'newLeads', 'signIn', 'portalRead', 'portalWrite',
  'viewInvoices', 'payInvoices', 'autoCharge', 'apiKeys',
];

const CASES = (Object.keys(MATRIX) as BuilderStatus[]).flatMap((status) =>
  CAPABILITIES.map((cap, i) => [status, cap, MATRIX[status][i]!] as const),
);

describe('builder status policy matrix (#860)', () => {
  it.each(CASES)('%s × %s → %s', (status, capability, allowed) => {
    expect(builderStatusAllows(status, capability)).toBe(allowed);
    if (allowed) {
      expect(() => requireBuilderCapability(status, capability)).not.toThrow();
    } else {
      expect(() => requireBuilderCapability(status, capability)).toThrow(
        expect.objectContaining({ status: 403, code: 'BUILDER_PAUSED' }),
      );
    }
  });

  it('legacy inactive reads as suspended', () => {
    expect(normalizeBuilderStatus('inactive')).toBe('suspended');
    for (const cap of CAPABILITIES) {
      expect(builderStatusAllows('inactive', cap)).toBe(builderStatusAllows('suspended', cap));
    }
  });

  it.each([null, undefined, '', 'deleted', 'ACTIVE'])('unknown status %j fails closed', (status) => {
    expect(normalizeBuilderStatus(status)).toBeNull();
    for (const cap of CAPABILITIES) expect(builderStatusAllows(status, cap)).toBe(false);
  });

  it('the paused error tells offboarded builders the account is closed', () => {
    expect(builderPausedError('offboarded').message).toMatch(/closed/);
    expect(builderPausedError('suspended').message).toMatch(/paused/);
  });
});
