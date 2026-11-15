/**
 * Agreement-gate fakes (#722) for tests of the money paths that are not
 * about the agreement itself. `ACCEPTED_AGREEMENTS` behaves as if every org
 * accepted the current platform agreement; `blockedAgreements()` as if none
 * did (409 AGREEMENT_REQUIRED from `requireCurrentForTenant`).
 */
import type { AgreementGate } from '../../src/services/builder-agreement.service';
import { agreementRequiredError } from '../../src/services/builder-agreement.service';

export const ACCEPTED_AGREEMENTS: AgreementGate = {
  isCurrentForTenant: async () => true,
  requireCurrentForTenant: async () => undefined,
};

/** Every tenant except those in `accepted` lacks a current acceptance. */
export function blockedAgreements(
  accepted: readonly string[] = [],
): AgreementGate {
  return {
    isCurrentForTenant: async (tenantKey) => accepted.includes(tenantKey),
    requireCurrentForTenant: async (tenantKey) => {
      if (!accepted.includes(tenantKey)) throw agreementRequiredError();
    },
  };
}
