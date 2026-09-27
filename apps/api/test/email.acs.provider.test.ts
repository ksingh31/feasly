/**
 * ACS email provider tests (story email/01).
 *
 * The Azure Communication Services SDK is mocked at the module boundary —
 * no network, no credentials, no provisioning. Covers: fail-closed without
 * a connection string, message shaping (sender identity, recipients,
 * headers), the Succeeded/failed poller paths, and error sanitization
 * (connection strings and recipient addresses never leak into errors).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAcsEmailProvider,
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

function provider() {
  return createAcsEmailProvider({
    connectionString: 'endpoint=https://example.com;accesskey=fake',
    fromAddress: 'noreply@feasly.example',
  });
}

/** Provider with a short poll deadline for timeout tests. */
function providerWithTimeout(deliveryPollTimeoutMs: number) {
  return createAcsEmailProvider({
    connectionString: 'endpoint=https://example.com;accesskey=fake',
    fromAddress: 'noreply@feasly.example',
    deliveryPollTimeoutMs,
  });
}

beforeEach(() => {
  mockBeginSend.mockReset();
});

describe('acs provider', () => {
  it('fails closed without a connection string, naming the env var', async () => {
    const p = createAcsEmailProvider({
      connectionString: undefined,
      fromAddress: 'noreply@feasly.example',
    });
    await expect(p.send(MESSAGE)).rejects.toThrow(/EMAIL_ACS_CONNECTION_STRING/);
    expect(mockBeginSend).not.toHaveBeenCalled();
  });

  it('shapes the ACS message and returns the provider message id', async () => {
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn().mockResolvedValue({
        id: 'acs-msg-123',
        status: 'Succeeded',
      }),
    });
    const result = await provider().send({
      ...MESSAGE,
      headers: { 'List-Unsubscribe': '<https://x/unsub>' },
    });
    expect(result).toEqual({ provider: 'acs', messageId: 'acs-msg-123' });

    const sent = mockBeginSend.mock.calls[0][0];
    expect(sent.senderAddress).toBe('noreply@feasly.example');
    expect(sent.recipients.to).toEqual([{ address: 'lead@example.com' }]);
    expect(sent.content.subject).toBe(MESSAGE.subject);
    expect(sent.content.plainText).toBe(MESSAGE.text);
    expect(sent.content.html).toBe(MESSAGE.html);
    expect(sent.headers).toEqual({ 'List-Unsubscribe': '<https://x/unsub>' });
  });

  it('throws EmailProviderError when the poller reports failure', async () => {
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn().mockResolvedValue({
        id: 'acs-msg-456',
        status: 'Failed',
        error: { message: 'sender address not verified for lead@example.com' },
      }),
    });
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    // Recipient address is redacted from the surfaced error.
    expect(error.message).not.toContain('lead@example.com');
    expect(error.message).toContain('[redacted-recipient]');
  });

  it('wraps SDK send failures without leaking the connection string', async () => {
    mockBeginSend.mockRejectedValue(
      new Error('401 Unauthorized: endpoint=https://real.example.net/;accesskey=topsecretkey'),
    );
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.message).not.toContain('accesskey=');
    expect(error.message).not.toContain('topsecretkey');
    expect(error.message).toContain('[redacted-connection-string]');
  });

  it('wraps polling failures as EmailProviderError', async () => {
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn().mockRejectedValue(new Error('polling timed out')),
    });
    await expect(provider().send(MESSAGE)).rejects.toThrow(EmailProviderError);
  });

  it('passes an abortSignal to the delivery poll so the SDK can cancel', async () => {
    const pollUntilDone = vi.fn().mockResolvedValue({
      id: 'acs-msg-123',
      status: 'Succeeded',
    });
    mockBeginSend.mockResolvedValue({ pollUntilDone });
    await provider().send(MESSAGE);
    const pollOptions = pollUntilDone.mock.calls[0][0] as
      | { abortSignal?: AbortSignal }
      | undefined;
    expect(pollOptions?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('fails loud when the delivery poll stalls past the deadline', async () => {
    // 2026-09-27: a stalled ACS poll held the lead-submit HTTP response
    // open (gate "Sending..." hang). The deadline must bound the send even
    // when the poller ignores the abortSignal (never-resolving mock).
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn(() => new Promise(() => {})),
    });
    const started = Date.now();
    const error = await providerWithTimeout(50).send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.message).toContain('delivery polling timed out after 50ms');
    // Bounded, not forever: comfortably under 5s.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not fire the timeout when the poll completes first', async () => {
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn().mockResolvedValue({
        id: 'acs-msg-789',
        status: 'Succeeded',
      }),
    });
    const result = await providerWithTimeout(50).send(MESSAGE);
    expect(result).toEqual({ provider: 'acs', messageId: 'acs-msg-789' });
    // Let the 50ms timer elapse: no late send-failure should surface.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
