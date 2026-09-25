/**
 * Sandbox-suppressing EmailService tests (api-mcp/01).
 *
 * AC: `feasly_test_` keys set sandbox=true, and sandbox writes must not
 * send emails. The decorator suppresses every send method.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSandboxSuppressingEmailService } from '../src/services/email/sandbox-email.service';
import type { EmailService } from '../src/services/email/email.service';

const INNER = {
  sendMagicLink: vi.fn(),
  sendPartnerShare: vi.fn(),
  sendCallbackConfirmation: vi.fn(),
  sendNudge: vi.fn(),
  sendOpsAlert: vi.fn(),
} as unknown as EmailService;

describe('sandbox-suppressing email service (api-mcp/01)', () => {
  it('suppresses every send method without calling the inner service', async () => {
    const log = vi.fn();
    const service = createSandboxSuppressingEmailService({ inner: INNER, log });

    const results = await Promise.all([
      service.sendMagicLink({} as never),
      service.sendPartnerShare({} as never),
      service.sendCallbackConfirmation({} as never),
      service.sendNudge({} as never),
      service.sendOpsAlert({} as never),
    ]);

    for (const fn of Object.values(INNER)) {
      expect(fn).not.toHaveBeenCalled();
    }
    for (const result of results) {
      expect(result.messageId).toBe('sandbox-suppressed');
    }
    expect(log).toHaveBeenCalledTimes(5);
    // No PII in suppression logs.
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toMatch(/@/);
    }
  });
});
