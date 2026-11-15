/** Contract-shaped #722 fixtures shared by the onboarding/agreement specs. */
import type { AgreementStatus, BuilderOnboardingStatus } from '@feasly/contracts';

export const AGREEMENT_PENDING: AgreementStatus = {
  version: 'v2',
  current: false,
  acceptedAt: null,
  acceptedBy: null,
  canAccept: true,
  document: {
    version: 'v2',
    title: 'Platform Agreement',
    status: 'draft-pending-lawyer',
    sections: [{ heading: 'Commission', paragraphs: ['First.', 'Second.'] }],
  },
};

export const AGREEMENT_ACCEPTED: AgreementStatus = {
  ...AGREEMENT_PENDING,
  current: true,
  acceptedAt: '2026-11-10T18:00:00Z',
  acceptedBy: { userId: 'u1', name: 'Dana Admin', email: 'dana@example.ca' },
};

export function onboardingOf(
  overrides: Partial<BuilderOnboardingStatus> = {},
): BuilderOnboardingStatus {
  return {
    agreementAccepted: false,
    profileComplete: true,
    paymentMethodSet: false,
    embedVerified: false,
    teamInvited: true,
    complete: false,
    isAdmin: true,
    agreement: AGREEMENT_PENDING,
    ...overrides,
  };
}
