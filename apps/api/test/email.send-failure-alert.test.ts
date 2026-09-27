/**
 * Consumer email send-failure alerting (P0 follow-up to the Sep 2026
 * magic-link email outage: sends threw with the UI claiming success, and
 * no alert fired).
 *
 * The ACS provider emits a structured `email.send-failed` JSON log line
 * (console → Application Insights `AppTraces`) at every send-failure throw
 * site; the `${namePrefix}-email-send-failures` scheduled query rule in
 * `infra/bicep/modules/alerts.bicep` keys off that event name.
 *
 * These tests verify:
 *  1. Every provider throw path emits a log line the alert query matches
 *     (send rejected, delivery polling failed, not delivered).
 *  2. The line carries NO PII — no email address, no token, no connection
 *     string — even when the underlying SDK error text contains them.
 *  3. The Bicep alert query and the code's event name cannot drift apart:
 *     the query must reference the exact exported event constant, with the
 *     agreed threshold (>2 in 15 min), severity 2, and the ops action group.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAcsEmailProvider,
  EMAIL_SEND_FAILED_EVENT,
  EmailProviderError,
  type EmailMessage,
} from '../src/services/email';

const { mockBeginSend } = vi.hoisted(() => ({
  mockBeginSend: vi.fn(),
}));

vi.mock('@azure/communication-email', () => ({
  EmailClient: class MockEmailClient {
    beginSend = mockBeginSend;
  },
}));

const MESSAGE: EmailMessage = {
  to: 'lead@example.com',
  subject: 'Your Feasly estimate is ready',
  html: '<p>hi</p>',
  text: 'hi',
};

const LEAKY_SDK_ERROR = new Error(
  '401 Unauthorized for sender noreply@feasly.example to lead@example.com, ' +
    'link https://feasly.example/r/' +
    'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
);

function provider() {
  return createAcsEmailProvider({
    connectionString: 'endpoint=https://example.com;accesskey=fake',
    fromAddress: 'noreply@feasly.example',
  });
}

/** Capture everything the provider writes to console.error during send(). */
async function captureSendErrorLines(
  run: () => Promise<unknown>,
): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await expect(run()).rejects.toThrow(EmailProviderError);
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterEach(() => {
  mockBeginSend.mockReset();
});

describe('email send-failure structured logging', () => {
  it.each([
    {
      name: 'send rejected',
      context: 'send rejected',
      setup: () => mockBeginSend.mockRejectedValue(LEAKY_SDK_ERROR),
    },
    {
      name: 'delivery polling failed',
      context: 'delivery polling failed',
      setup: () =>
        mockBeginSend.mockResolvedValue({
          pollUntilDone: vi.fn().mockRejectedValue(new Error('polling timed out')),
        }),
    },
    {
      name: 'not delivered',
      context: 'not delivered',
      setup: () =>
        mockBeginSend.mockResolvedValue({
          pollUntilDone: vi.fn().mockResolvedValue({
            id: 'acs-msg-789',
            status: 'Failed',
            error: { message: 'sender address not verified for lead@example.com' },
          }),
        }),
    },
  ])('emits a structured event when $name', async ({ context, setup }) => {
    setup();
    const lines = await captureSendErrorLines(() => provider().send(MESSAGE));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    // The Bicep alert query is `Message contains "email.send-failed"` —
    // the JSON body must contain the event name verbatim.
    expect(parsed.event).toBe(EMAIL_SEND_FAILED_EVENT);
    expect(lines[0]).toContain(EMAIL_SEND_FAILED_EVENT);
    expect(parsed.provider).toBe('acs');
    expect(parsed.context).toBe(context);
    expect(typeof parsed.error).toBe('string');
  });

  it('never logs PII — no email, token, or credential in the failure line', async () => {
    mockBeginSend.mockRejectedValue(LEAKY_SDK_ERROR);
    const lines = await captureSendErrorLines(() => provider().send(MESSAGE));
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).not.toContain('lead@example.com');
    expect(line).not.toContain('noreply@feasly.example');
    expect(line).toContain('[redacted-token]');
    expect(line).not.toMatch(/[0-9a-f]{64}/i);
    expect(line).not.toContain(MESSAGE.subject);
    expect(line).not.toContain(MESSAGE.html);
  });

  it('the alert query cannot drift from the code: Bicep references the exported event name', () => {
    const bicep = readFileSync(
      join(__dirname, '..', '..', '..', 'infra', 'bicep', 'modules', 'alerts.bicep'),
      'utf8',
    );
    // The scheduled query rule for email send failures…
    expect(bicep).toContain('email-send-failures');
    expect(bicep).toContain('Microsoft.Insights/scheduledQueryRules');
    // …keys off the exact event name the provider emits…
    expect(bicep).toContain(EMAIL_SEND_FAILED_EVENT);
    // …with >2 failures in 15 min, severity 2, to the ops action group.
    expect(bicep).toMatch(/query: 'AppTraces \| where TimeGenerated > ago\(15m\)/);
    expect(bicep).toContain('threshold: 2');
    expect(bicep).toContain('evaluationFrequency: \'PT15M\'');
    expect(bicep).toContain('severity: 2');
    expect(bicep).toContain('actionGroup.id');
  });
});
