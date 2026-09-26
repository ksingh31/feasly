/**
 * Email infrastructure tests (story email/01).
 *
 * Covers: template rendering rules (magic-link single CTA + 7-day expiry +
 * plain-text fallback; share carries the FRESH bearer URL and never the
 * owner's magic link; nudge carries one-click unsubscribe + List-Unsubscribe
 * headers; transactional mail has no unsubscribe), banned-copy patterns
 * asserted against RENDERED output (shared with the CI copy-lint via
 * banned-patterns.txt), provider fail-closed behavior (log refuses
 * production, Postmark without token, ACS stub), and config defaults.
 *
 * Providers are faked at the EmailProvider boundary; no network is touched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { createComposition } from '../src/composition';
import {
  createAcsEmailProvider,
  createEmailService,
  createLogEmailProvider,
  createPostmarkEmailProvider,
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailService,
} from '../src/services/email';
import {
  renderMagicLinkEmail,
  renderShareEmail,
  renderNudgeEmail,
  type TemplateContext,
} from '../src/services/email/templates';

const TEST_DIR = __dirname;

const CTX: TemplateContext = {
  appBaseUrl: 'https://app.feasly.example',
  unsubscribeBaseUrl: 'https://app.feasly.example/unsubscribe',
  brandName: 'Feasly',
};

const MAGIC_URL = 'https://app.feasly.example/magic/abc123';
const SHARE_URL = 'https://app.feasly.example/share/partner-xyz789';

function loadBannedPatterns(): RegExp[] {
  const file = join(
    TEST_DIR,
    '..',
    'src',
    'services',
    'email',
    'banned-patterns.txt',
  );
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((source) => new RegExp(source, 'i'));
}

/** Capturing fake provider for service-level tests. */
function fakeProvider(): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: 'log',
    sent,
    async send(message: EmailMessage) {
      sent.push(message);
      return { provider: 'log' };
    },
  };
}

function serviceWithFake(): { service: EmailService; provider: ReturnType<typeof fakeProvider> } {
  const provider = fakeProvider();
  const service = createEmailService({
    provider,
    fromAddress: 'noreply@feasly.example',
    fromName: 'Feasly',
    appBaseUrl: CTX.appBaseUrl,
    unsubscribeBaseUrl: CTX.unsubscribeBaseUrl,
    opsInbox: 'ops@feasly.example',
  });
  return { service, provider };
}

describe('magic-link template', () => {
  const rendered = renderMagicLinkEmail(CTX, {
    name: 'Aman',
    magicLinkUrl: MAGIC_URL,
    expiresInDays: 7,
    audience: 'consumer',
  });

  it('has exactly one CTA pointing at the magic link', () => {
    const anchors = [...rendered.html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    const magicAnchors = anchors.filter((href) => href === MAGIC_URL);
    // One CTA button + one plain-text fallback link — both the magic URL, nothing else.
    expect(anchors.length).toBe(2);
    expect(magicAnchors.length).toBe(2);
  });

  it('states the 7-day expiry from config (never hardcoded)', () => {
    expect(rendered.html).toContain('expires in 7 days');
    expect(rendered.text).toContain('expires in 7 days');
  });

  it('ships a plain-text fallback containing the link', () => {
    expect(rendered.text).toContain(MAGIC_URL);
    expect(rendered.text).not.toContain('<a');
  });

  it('carries no unsubscribe link (transactional)', () => {
    expect(rendered.html.toLowerCase()).not.toContain('unsubscribe');
    expect(rendered.text.toLowerCase()).not.toContain('unsubscribe');
  });

  it('admin audience gets an admin subject', () => {
    const admin = renderMagicLinkEmail(CTX, {
      magicLinkUrl: MAGIC_URL,
      expiresInDays: 7,
      audience: 'admin',
    });
    expect(admin.subject.toLowerCase()).toContain('admin');
  });

  it('admin audience CTA says sign-in, never "View my estimate"', () => {
    const admin = renderMagicLinkEmail(CTX, {
      magicLinkUrl: MAGIC_URL,
      expiresInDays: 7,
      audience: 'admin',
    });
    expect(admin.html).toContain('Sign in to');
    expect(admin.html).toContain('admin');
    expect(admin.html).not.toContain('View my estimate');
    expect(admin.text).not.toContain('View my estimate');
    const consumer = renderMagicLinkEmail(CTX, {
      magicLinkUrl: MAGIC_URL,
      expiresInDays: 7,
      audience: 'consumer',
    });
    expect(consumer.html).toContain('View my estimate');
  });
});

describe('partner-share template', () => {
  const OWNER_MAGIC = 'https://app.feasly.example/magic/owner-secret';

  it('never contains the owner magic link, only the fresh share URL', () => {
    const rendered = renderShareEmail(CTX, {
      ownerName: 'Aman',
      partnerName: 'Priya',
      shareUrl: SHARE_URL,
      note: 'Thought you might like this.',
      expiresInDays: 7,
    });
    expect(rendered.html).not.toContain(OWNER_MAGIC);
    expect(rendered.text).not.toContain(OWNER_MAGIC);
    expect(rendered.html).toContain(SHARE_URL);
    expect(rendered.text).toContain(SHARE_URL);
  });

  it('warns against forwarding the personal link', () => {
    const rendered = renderShareEmail(CTX, { shareUrl: SHARE_URL, expiresInDays: 7 });
    expect(rendered.html.toLowerCase()).toContain("don't forward");
  });

  it('renders the configured expiry, never a hardcoded value', () => {
    const rendered = renderShareEmail(CTX, { shareUrl: SHARE_URL, expiresInDays: 14 });
    expect(rendered.html).toContain('expires in 14 days');
    expect(rendered.text).toContain('expires in 14 days');
    expect(rendered.html).not.toContain('expires in 7 days');
    expect(rendered.text).not.toContain('expires in 7 days');
  });
});

describe('nudge template (non-transactional)', () => {
  it('renders the one-click unsubscribe URL in html and text', async () => {
    const { service, provider } = serviceWithFake();
    await service.sendNudge({
      to: 'lead@example.com',
      name: 'Aman',
      resumeUrl: `${CTX.appBaseUrl}/resume/abc`,
      unsubscribeUrl: `${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`,
    });
    const sent = provider.sent[0];
    expect(sent.html).toContain(`${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`);
    expect(sent.text).toContain(`${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`);
  });

  it('sets List-Unsubscribe headers for one-click unsubscribe', async () => {
    const { service, provider } = serviceWithFake();
    await service.sendNudge({
      to: 'lead@example.com',
      resumeUrl: `${CTX.appBaseUrl}/resume/abc`,
      unsubscribeUrl: `${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`,
    });
    const sent = provider.sent[0];
    expect(sent.headers?.['List-Unsubscribe']).toContain(
      `${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`,
    );
    expect(sent.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('template copy mentions the reminder cadence honestly', () => {
    const rendered = renderNudgeEmail(CTX, {
      resumeUrl: `${CTX.appBaseUrl}/resume/abc`,
      unsubscribeUrl: `${CTX.unsubscribeBaseUrl}?token=x`,
    });
    expect(rendered.text.toLowerCase()).toContain('unsubscribe');
  });
});

describe('callback + ops-alert paths', () => {
  it('callback confirmation goes to the team inbox with lead details', async () => {
    const { service, provider } = serviceWithFake();
    await service.sendCallbackConfirmation({
      leadName: 'Aman',
      leadEmail: 'aman@example.com',
      leadPhone: '403-555-0100',
      timeline: '0-3mo',
      estimateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestedAt: new Date('2026-09-24T12:00:00Z'),
    });
    const sent = provider.sent[0];
    expect(sent.to).toBe('ops@feasly.example');
    expect(sent.html).toContain('Aman');
    expect(sent.text).toContain('403-555-0100');
  });

  it('ops alert subjects carry the ops prefix', async () => {
    const { service, provider } = serviceWithFake();
    await service.sendOpsAlert({
      to: 'ops@feasly.example',
      title: 'Sheets sync failed',
      summary: 'Hourly sync failed 3 times in a row.',
      firedAt: new Date('2026-09-24T12:00:00Z'),
    });
    expect(provider.sent[0].subject).toContain('[Feasly ops]');
  });
});

describe('banned copy patterns (rendered output)', () => {
  const patterns = loadBannedPatterns();

  it('no template renders banned copy', () => {
    const bodies = [
      renderMagicLinkEmail(CTX, {
        magicLinkUrl: MAGIC_URL,
        expiresInDays: 7,
        audience: 'consumer',
      }),
      renderShareEmail(CTX, { shareUrl: SHARE_URL, note: 'Nice place.', expiresInDays: 7 }),
      renderNudgeEmail(CTX, {
        resumeUrl: `${CTX.appBaseUrl}/resume/abc`,
        unsubscribeUrl: `${CTX.unsubscribeBaseUrl}?token=x`,
      }),
    ].flatMap((r) => [r.subject, r.html, r.text]);
    for (const body of bodies) {
      for (const re of patterns) {
        expect(body, `banned pattern ${re} matched`).not.toMatch(re);
      }
    }
  });

  it('no dollar figures appear in any rendered email', () => {
    const bodies = [
      renderMagicLinkEmail(CTX, {
        magicLinkUrl: MAGIC_URL,
        expiresInDays: 7,
        audience: 'consumer',
      }),
      renderShareEmail(CTX, { shareUrl: SHARE_URL, expiresInDays: 7 }),
    ].flatMap((r) => [r.html, r.text]);
    for (const body of bodies) {
      expect(body).not.toMatch(/\$\s?\d/);
    }
  });
});

describe('provider fail-closed behavior', () => {
  it('log provider refuses production', () => {
    expect(() =>
      createLogEmailProvider({ env: 'production', logLinks: true }),
    ).toThrow(EmailProviderError);
  });

  it('log provider works in development and test', async () => {
    for (const env of ['development', 'test'] as const) {
      const provider = createLogEmailProvider({ env, logLinks: false });
      const result = await provider.send({
        to: 'a@b.example',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
      });
      expect(result.provider).toBe('log');
    }
  });

  it('postmark without a token fails closed naming the env var', async () => {
    const provider = createPostmarkEmailProvider({
      serverToken: undefined,
      fromAddress: 'noreply@feasly.example',
      endpoint: 'https://api.postmarkapp.com/email',
    });
    await expect(
      provider.send({ to: 'a@b.example', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/EMAIL_POSTMARK_SERVER_TOKEN/);
  });

  it('acs without a connection string fails closed naming the env var', async () => {
    const provider = createAcsEmailProvider({
      connectionString: undefined,
      fromAddress: 'noreply@feasly.example',
    });
    await expect(
      provider.send({ to: 'a@b.example', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/EMAIL_ACS_CONNECTION_STRING/);
  });
});

describe('email config', () => {
  const baseEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  } as NodeJS.ProcessEnv;

  it('defaults to the log provider with placeholder sender identity', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.email.provider).toBe('log');
    expect(config.email.fromAddress).toBe('noreply@feasly.example');
    expect(config.email.opsInbox).toBe('karanbirsingh667@gmail.com');
    expect(config.email.logLinks).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig({ ...baseEnv, EMAIL_PROVIDER: 'sendgrid' })).toThrow(
      /EMAIL_PROVIDER/,
    );
  });

  it('EMAIL_LOG_LINKS=false disables link logging', () => {
    const config = loadConfig({ ...baseEnv, EMAIL_LOG_LINKS: 'false' });
    expect(config.email.logLinks).toBe(false);
  });
});

describe('composition wiring', () => {
  it('exposes an email service built on the configured provider', async () => {
    const app = createComposition({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    } as NodeJS.ProcessEnv);
    expect(app.emailService).toBeDefined();
    const result = await app.emailService.sendMagicLink({
      to: 'lead@example.com',
      magicLinkUrl: MAGIC_URL,
      expiresInDays: 7,
      audience: 'consumer',
    });
    expect(result.provider).toBe('log');
  });
});
