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

/** Provider with a short send deadline for timeout tests. */
function providerWithTimeout(sendTimeoutMs: number) {
  return createAcsEmailProvider({
    connectionString: 'endpoint=https://example.com;accesskey=fake',
    fromAddress: 'noreply@feasly.example',
    sendTimeoutMs,
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

  it('fails loud when beginSend stalls past the deadline (2026-09-28 gate hang)', async () => {
    // The 2026-09-27 fix bounded only the delivery poll — beginSend()
    // itself was an unbounded await and held the lead-submit HTTP response
    // open with no backend completion row. A stalled beginSend must fail
    // loud inside the deadline.
    mockBeginSend.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const error = await providerWithTimeout(50).send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.message).toContain('beginSend timed out after 50ms');
    // Bounded, not forever: comfortably under 5s.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('marks a stalled beginSend as RETRYABLE delivery-failed (never reached ACS)', async () => {
    // beginSend never resolved, so the message never reached the provider:
    // retrying cannot duplicate anything — unlike the poll-phase timeout.
    mockBeginSend.mockImplementation(() => new Promise(() => {}));
    const error = await providerWithTimeout(50).send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.retryable).toBe(true);
    expect(error.failureCode).toBe('delivery-failed');
    expect(error.sendAccepted ?? false).toBe(false);
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

describe('acs provider failure classification (retry)', () => {
  /** Fake an Azure SDK RestError: statusCode carried on the error itself. */
  function restError(statusCode: number, message: string): Error {
    const error = new Error(message) as Error & { statusCode: number };
    error.statusCode = statusCode;
    return error;
  }

  it('marks a 400 beginSend rejection as non-retryable invalid-recipient', async () => {
    // Karan 2026-09-27: the address comes straight from user input, so a
    // beginSend 400 is the user's typo — no retry, straight to the
    // "check for typos" copy.
    mockBeginSend.mockRejectedValue(
      restError(400, 'The request is malformed'),
    );
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.retryable).toBe(false);
    expect(error.failureCode).toBe('invalid-recipient');
  });

  it('classifies a recipient-rejected 400 as invalid-recipient (check for typos, no retry)', async () => {
    mockBeginSend.mockRejectedValue(
      restError(400, 'Invalid recipient email address'),
    );
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error.retryable).toBe(false);
    expect(error.failureCode).toBe('invalid-recipient');
  });

  it('does NOT blame the user for a sender-side 400 ("invalid sender address")', async () => {
    mockBeginSend.mockRejectedValue(
      restError(400, 'Invalid sender address: domain not verified'),
    );
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error.retryable).toBe(false);
    // Permanent, but not the user's typo — delivery-failed copy applies.
    expect(error.failureCode).toBe('delivery-failed');
  });

  it('marks 429 and 5xx beginSend rejections as retryable', async () => {
    for (const status of [429, 500, 503]) {
      mockBeginSend.mockRejectedValue(restError(status, `HTTP ${status}`));
      const error = await provider().send(MESSAGE).catch((e) => e);
      expect(error.retryable).toBe(true);
      expect(error.failureCode).toBe('delivery-failed');
    }
  });

  it('marks the delivery-poll timeout as non-retryable + sendAccepted (P0 2026-09-27)', async () => {
    // beginSend() ACCEPTED the message; only the delivery poll stalled.
    // Retrying would re-run beginSend() and duplicate an already-delivered
    // email (Karan's triple "estimate is ready" emails). The timeout is
    // therefore non-retryable with sendAccepted: true — deliver() returns
    // sent:false immediately and the caller suppresses resubmits.
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn(() => new Promise(() => {})),
    });
    const error = await providerWithTimeout(50).send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.retryable).toBe(false);
    expect(error.failureCode).toBe('delivery-failed');
    expect(error.sendAccepted).toBe(true);
    // Exactly one beginSend — the timeout never starts a second send.
    expect(mockBeginSend).toHaveBeenCalledTimes(1);
  });

  it('marks a bounced delivery (550) as non-retryable invalid-recipient', async () => {
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn().mockResolvedValue({
        id: 'acs-msg-bounce',
        status: 'Failed',
        error: { message: '550 5.1.1 mailbox unavailable' },
      }),
    });
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error.retryable).toBe(false);
    expect(error.failureCode).toBe('invalid-recipient');
  });

  it('marks a generic delivery failure as retryable', async () => {
    mockBeginSend.mockResolvedValue({
      pollUntilDone: vi.fn().mockResolvedValue({
        id: 'acs-msg-x',
        status: 'Failed',
        error: { message: 'transient upstream error' },
      }),
    });
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error.retryable).toBe(true);
    expect(error.failureCode).toBe('delivery-failed');
  });

  it('marks missing configuration as non-retryable', async () => {
    const p = createAcsEmailProvider({
      connectionString: undefined,
      fromAddress: 'noreply@feasly.example',
    });
    const error = await p.send(MESSAGE).catch((e) => e);
    expect(error.retryable).toBe(false);
    expect(error.failureCode).toBe('delivery-failed');
  });
});
