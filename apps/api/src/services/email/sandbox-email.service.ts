/**
 * Sandbox-suppressing EmailService decorator (api-mcp/01).
 *
 * When a request is authenticated with a `feasly_test_` API key, the auth
 * context carries `sandbox: true` — and sandbox writes MUST NOT send
 * emails. Routes wrap their EmailService with this decorator when the
 * auth context is sandboxed: every send method becomes a no-op that logs
 * the suppression (no PII in the log) and returns a synthetic result.
 *
 * This is a decorator, not a flag on the service interface, so the
 * production EmailService and all its callers are untouched — the sandbox
 * decision lives at the route layer where the API key auth context is
 * available.
 */
import type {
  EmailService,
  MagicLinkEmailInput,
  NudgeEmailInput,
  OpsAlertEmailInput,
  PartnerShareEmailInput,
  CallbackConfirmationInput,
} from './email.service';
import type { EmailSendResult } from './email.types';

export interface SandboxEmailServiceDeps {
  readonly inner: EmailService;
  readonly log?: (message: string) => void;
}

const SUPPRESSED_RESULT: EmailSendResult = {
  provider: 'log',
  messageId: 'sandbox-suppressed',
};

function suppressed(
  method: string,
  log?: (message: string) => void,
): Promise<EmailSendResult> {
  // No recipient, subject, or body — the fact of suppression is all we log.
  log?.(`[sandbox] suppressed email send via ${method}`);
  return Promise.resolve(SUPPRESSED_RESULT);
}

export function createSandboxSuppressingEmailService(
  deps: SandboxEmailServiceDeps,
): EmailService {
  const { inner, log } = deps;
  void inner; // The inner service is intentionally never called.
  return {
    sendMagicLink: (_input: MagicLinkEmailInput) =>
      suppressed('sendMagicLink', log),
    sendPartnerShare: (_input: PartnerShareEmailInput) =>
      suppressed('sendPartnerShare', log),
    sendCallbackConfirmation: (_input: CallbackConfirmationInput) =>
      suppressed('sendCallbackConfirmation', log),
    sendNudge: (_input: NudgeEmailInput) => suppressed('sendNudge', log),
    sendOpsAlert: (_input: OpsAlertEmailInput) =>
      suppressed('sendOpsAlert', log),
  };
}
