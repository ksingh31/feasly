/** Onboarding checklist step ids, in display order (#722). */
export const ONBOARDING_STEP_IDS = ['agreement', 'profile', 'payment', 'embed', 'team'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** Load the org's agreement status + text (GET /builder/agreement). */
export class LoadBuilderAgreement {
  static readonly type = '[BuilderOnboarding] Load agreement';
}

/** Load the first-run checklist flags (GET /builder/onboarding). */
export class LoadBuilderOnboarding {
  static readonly type = '[BuilderOnboarding] Load onboarding';
}

/** Accept the given (current) agreement version — org admins only. */
export class AcceptBuilderAgreement {
  static readonly type = '[BuilderOnboarding] Accept agreement';
  constructor(public readonly version: string) {}
}

/**
 * A money call answered 409 AGREEMENT_REQUIRED: the cached status is
 * stale (e.g. the version was bumped mid-session). Marks it not current so
 * the agreement guard refetches instead of trusting the cache.
 */
export class MarkBuilderAgreementRequired {
  static readonly type = '[BuilderOnboarding] Agreement required';
}

/** Hide a COMPLETED checklist step for this org (persisted). */
export class DismissOnboardingStep {
  static readonly type = '[BuilderChecklist] Dismiss step';
  constructor(
    public readonly builderId: string,
    public readonly step: OnboardingStepId,
  ) {}
}
