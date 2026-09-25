/**
 * Consent actions (story consumer/01). The banner dispatches exactly one of
 * these; the state records the choice and the acknowledgement timestamp.
 */
export class AcknowledgeConsent {
  static readonly type = '[Consent] Acknowledge banner';
  constructor(public readonly granted: boolean) {}
}

export class ResetConsent {
  static readonly type = '[Consent] Reset (re-show banner)';
}
