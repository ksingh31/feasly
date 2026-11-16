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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, SEED_ADMIN_EMAIL } from '../src/config';
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
  renderErasureConfirmationEmail,
  renderFollowUpEmail,
  renderMagicLinkEmail,
  renderShareEmail,
  renderNudgeEmail,
  type TemplateContext,
} from '../src/services/email/templates';
import {
  BUILD_TIMELINES,
  resolveBuildTimeline,
  type BuildTimeline,
} from '../src/lib/build-timeline';

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

  it('states the 7-day lifetime from config when no expiry date is passed', () => {
    expect(rendered.html).toContain('works for 7 days');
    expect(rendered.text).toContain('works for 7 days');
  });

  it('ships a plain-text fallback containing the link', () => {
    expect(rendered.text).toContain(MAGIC_URL);
    expect(rendered.text).not.toContain('<a');
  });

  it('consumer audience carries the unsubscribe footer with the tokenized URL', () => {
    const withFooter = renderMagicLinkEmail(CTX, {
      name: 'Aman',
      magicLinkUrl: MAGIC_URL,
      expiresInDays: 7,
      audience: 'consumer',
      unsubscribeUrl: `${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`,
    });
    expect(withFooter.html).toContain(`${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`);
    expect(withFooter.html.toLowerCase()).toContain('unsubscribe');
    expect(withFooter.html.toLowerCase()).toContain('manage email preferences');
    expect(withFooter.text).toContain(`${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`);
  });

  it('consumer magic link without a footer URL renders no footer (degraded send)', () => {
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

  it('admin/builder audiences never get the footer (team credentials, not lead marketing)', () => {
    for (const audience of ['admin', 'builder'] as const) {
      const team = renderMagicLinkEmail(CTX, {
        magicLinkUrl: MAGIC_URL,
        expiresInDays: 7,
        audience,
        // Even if a caller mistakenly passes one, the footer stays off.
        unsubscribeUrl: `${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`,
      });
      expect(team.html.toLowerCase()).not.toContain('unsubscribe');
      expect(team.text.toLowerCase()).not.toContain('unsubscribe');
    }
  });
});

const REPORT_INPUT = {
  name: 'Aman',
  magicLinkUrl: MAGIC_URL,
  expiresInDays: 7,
  audience: 'consumer' as const,
  unsubscribeUrl: `${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`,
  address: '1412 Prospect Av SW',
  // 2026-11-22 18:00 UTC = Nov 22, 2026 11:00 in America/Edmonton.
  expiresOn: new Date('2026-11-22T18:00:00Z'),
};

const FOLLOW_UP_INPUT = {
  name: 'Aman',
  address: '1412 Prospect Av SW',
  reportUrl: `${CTX.appBaseUrl}/r/fresh-owner-token`,
  unsubscribeUrl: `${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`,
};

describe('report email (#703)', () => {
  const rendered = renderMagicLinkEmail(CTX, REPORT_INPUT);

  it('AC1: subject and body name the property', () => {
    expect(rendered.subject).toBe('Your estimate for 1412 Prospect Av SW');
    expect(rendered.html).toContain('1412 Prospect Av SW');
    expect(rendered.text).toContain('1412 Prospect Av SW');
  });

  it('AC1: states the expiry DATE (Edmonton) and that the link is reusable', () => {
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain('works until Nov 22, 2026');
      expect(body).toContain('as often as you like');
    }
  });

  it('AC1: never claims the link can only be used once', () => {
    for (const body of [rendered.subject, rendered.html, rendered.text]) {
      expect(body.toLowerCase()).not.toContain('only be used once');
      expect(body.toLowerCase()).not.toContain('single-use');
    }
  });

  it('AC1: no dollar figures anywhere', () => {
    for (const body of [rendered.subject, rendered.html, rendered.text]) {
      expect(body).not.toMatch(/\$\s?\d/);
    }
  });

  it('lists what the report contains and how to get a fresh link', () => {
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain('estimated cost range');
      expect(body).toContain('line-by-line cost breakdown');
      expect(body).toContain('Next steps');
      expect(body).toContain('we will send you a fresh one');
    }
  });

  it('plain-text part matches the html content (no markup, same link + footer)', () => {
    expect(rendered.text).not.toMatch(/<[a-z]/i);
    expect(rendered.text).toContain(MAGIC_URL);
    expect(rendered.text).toContain(`${CTX.unsubscribeBaseUrl}/lead-1.iat.sig`);
  });

  it('escapes the address in html', () => {
    const evil = renderMagicLinkEmail(CTX, { ...REPORT_INPUT, address: '<b>1 X St</b>' });
    expect(evil.html).not.toContain('<b>1 X St</b>');
    expect(evil.html).toContain('&lt;b&gt;1 X St&lt;/b&gt;');
  });

  it('falls back to a generic subject without an address', () => {
    const generic = renderMagicLinkEmail(CTX, { ...REPORT_INPUT, address: undefined });
    expect(generic.subject).toBe('Your Feasly estimate is ready');
  });

  it('builder sign-in links (single-use by markUsed) keep the once-only line', () => {
    const builder = renderMagicLinkEmail(CTX, {
      magicLinkUrl: MAGIC_URL,
      expiresInDays: 7,
      audience: 'builder',
    });
    expect(builder.text).toContain('can only be used once');
  });

  it('every link is built from the configured URLs only', () => {
    for (const r of [rendered, renderFollowUpEmail(CTX, FOLLOW_UP_INPUT)]) {
      const hrefs = [...r.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href.startsWith(CTX.appBaseUrl)).toBe(true);
      }
    }
  });

  it('renders for narrow screens and dark-mode clients', () => {
    for (const r of [rendered, renderFollowUpEmail(CTX, FOLLOW_UP_INPUT)]) {
      // Narrow width: responsive viewport, fluid outer table, the card is
      // capped by max-width (not a fixed width), long URLs wrap.
      expect(r.html).toContain('name="viewport" content="width=device-width,initial-scale=1"');
      expect(r.html).toContain('width="100%"');
      expect(r.html).toContain('max-width:560px');
      expect(r.html).toContain('word-break:break-all');
      expect(r.html).not.toMatch(/width:\s*(?:[6-9]\d{2}|\d{4,})px/);
      // Dark mode: the light palette is declared so clients don't
      // auto-invert into unreadable brass-on-charcoal, and every text
      // block sets an explicit colour on an explicit background.
      expect(r.html).toContain('name="color-scheme" content="light only"');
      expect(r.html).toContain('name="supported-color-schemes" content="light only"');
      expect(r.html).toContain('background-color:#ffffff');
      expect(r.html).toContain('color:#232323');
    }
  });
});

describe('report email: typical build timeline (#823)', () => {
  const CALGARY = BUILD_TIMELINES['calgary']!;
  const withTimeline = renderMagicLinkEmail({ ...CTX, buildTimeline: CALGARY }, REPORT_INPUT);

  it('carries the 12–16 month total, every phase and the pre-sale note (html + text)', () => {
    for (const body of [withTimeline.html, withTimeline.text]) {
      expect(body).toContain('Typical new-build timeline');
      expect(body).toContain('Typical total: 12–16 months');
      for (const phase of CALGARY.phases) {
        expect(body).toContain(phase.label);
      }
      expect(body).toContain('2–4 weeks');
      expect(body).toContain(
        'Buying a pre-sale or move-in-ready home follows a different timeline.',
      );
    }
    expect(withTimeline.text).toContain('- Development permit: 2–4 months');
    expect(withTimeline.text).not.toMatch(/<[a-z]/i);
  });

  it('renders from config: a different timeline changes the email', () => {
    const custom: BuildTimeline = {
      totalMinMonths: 9,
      totalMaxMonths: 11,
      phases: [{ id: 'x', label: 'Permit review', min: 3, max: 5, unit: 'weeks' }],
    };
    const r = renderMagicLinkEmail({ ...CTX, buildTimeline: custom }, REPORT_INPUT);
    expect(r.text).toContain('Typical total: 9–11 months');
    expect(r.text).toContain('- Permit review: 3–5 weeks');
    expect(r.text).not.toContain('Development permit');
  });

  it('omits the block when no timeline is configured, and on team sign-in emails', () => {
    expect(renderMagicLinkEmail(CTX, REPORT_INPUT).text).not.toContain('Typical total');
    const builder = renderMagicLinkEmail(
      { ...CTX, buildTimeline: CALGARY },
      { magicLinkUrl: MAGIC_URL, expiresInDays: 7, audience: 'builder' },
    );
    expect(builder.text).not.toContain('Typical total');
  });

  it('stays clean: no dollar figures, no banned phrases', () => {
    const patterns = loadBannedPatterns();
    for (const body of [withTimeline.subject, withTimeline.html, withTimeline.text]) {
      expect(body).not.toMatch(/\$\s?\d/);
      for (const re of patterns) {
        expect(body).not.toMatch(re);
      }
    }
  });

  it('resolves the city case-insensitively; unknown cities have no timeline', () => {
    expect(resolveBuildTimeline(' Calgary ')).toBe(CALGARY);
    expect(resolveBuildTimeline('red-deer')).toBeUndefined();
  });

  it('the service renders the served city\'s timeline into the consumer email', async () => {
    const provider = fakeProvider();
    const service = createEmailService({
      provider,
      fromAddress: 'noreply@feasly.example',
      fromName: 'Feasly',
      appBaseUrl: CTX.appBaseUrl,
      unsubscribeBaseUrl: CTX.unsubscribeBaseUrl,
      opsInbox: 'ops@feasly.example',
      buildTimeline: CALGARY,
    });
    await service.sendMagicLink({ to: 'a@b.example', ...REPORT_INPUT });
    expect(provider.sent[0]?.text).toContain('Typical total: 12–16 months');
  });
});

describe('follow-up template (#703, non-transactional)', () => {
  const rendered = renderFollowUpEmail(CTX, FOLLOW_UP_INPUT);

  it('names the property and offers callback + adjust-inputs', () => {
    expect(rendered.subject).toBe('Questions about your estimate for 1412 Prospect Av SW?');
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain('Request a callback');
      expect(body).toContain('Adjust your inputs');
      expect(body).toContain(FOLLOW_UP_INPUT.reportUrl);
    }
  });

  it('carries the one-click unsubscribe footer in html and text', () => {
    expect(rendered.html).toContain(FOLLOW_UP_INPUT.unsubscribeUrl);
    expect(rendered.html.toLowerCase()).toContain('unsubscribe');
    expect(rendered.text).toContain(`Unsubscribe: ${FOLLOW_UP_INPUT.unsubscribeUrl}`);
  });

  it('sets List-Unsubscribe headers for one-click unsubscribe', async () => {
    const { service, provider } = serviceWithFake();
    await service.sendFollowUp({ to: 'home@example.com', ...FOLLOW_UP_INPUT });
    const msg = provider.sent[0]!;
    expect(msg.headers?.['List-Unsubscribe']).toBe(`<${FOLLOW_UP_INPUT.unsubscribeUrl}>`);
    expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
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

describe('#806 erase-confirmation email', () => {
  const CONFIRM_URL = `${CTX.appBaseUrl}/privacy/confirm/3f9b2c1a-0000-4000-8000-000000000000#token=abc123`;

  it('sends the confirm link to the person, transactional (no unsubscribe headers)', async () => {
    const { service, provider } = serviceWithFake();
    const delivery = await service.sendErasureConfirmation({
      to: 'jane@example.com',
      name: 'Jane',
      confirmUrl: CONFIRM_URL,
      expiresInHours: 24,
    });
    expect(delivery.sent).toBe(true);
    const sent = provider.sent[0]!;
    expect(sent.to).toBe('jane@example.com');
    expect(sent.subject).toMatch(/delete/i);
    expect(sent.text).toContain(CONFIRM_URL);
    expect(sent.html).toContain('Hi Jane,');
    expect(sent.text).toContain('24 hours');
    expect(sent.text).toContain('Nothing has been deleted yet');
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined();
  });

  it('escapes the name and singularises one hour', () => {
    const r = renderErasureConfirmationEmail(CTX, {
      name: '<b>x</b>',
      confirmUrl: CONFIRM_URL,
      expiresInHours: 1,
    });
    expect(r.html).not.toContain('<b>x</b>');
    expect(r.text).toContain('1 hour)');
  });

  it('does not claim single use — the link works until it expires (#806 review)', () => {
    const r = renderErasureConfirmationEmail(CTX, { confirmUrl: CONFIRM_URL, expiresInHours: 24 });
    expect(r.html).toContain('The link expires in 24 hours.');
    expect(r.text).toContain('the link expires in 24 hours');
    expect(`${r.html}${r.text}`).not.toMatch(/works once/i);
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

describe('in-code retry (deliver)', () => {
  const MAGIC_INPUT = {
    to: 'aman@example.com',
    magicLinkUrl: MAGIC_URL,
    expiresInDays: 7,
    audience: 'consumer' as const,
  };

  function transientError(): EmailProviderError {
    return new EmailProviderError(
      'Azure Communication Services email failed (delivery polling timed out after 6000ms).',
      { retryable: true, failureCode: 'delivery-failed' },
    );
  }

  function permanentError(): EmailProviderError {
    return new EmailProviderError(
      'Azure Communication Services email failed (invalid recipient).',
      { retryable: false, failureCode: 'invalid-recipient' },
    );
  }

  /**
   * Provider fake following a script of outcomes per attempt
   * ('transient' | 'permanent' | 'ok'); the last step repeats.
   */
  function scriptedService(
    script: Array<'transient' | 'permanent' | 'ok' | 'unknown'>,
    opts?: { maxAttempts?: number },
  ): { service: EmailService; attempts: number[] } {
    const attempts: number[] = [];
    const provider: EmailProvider = {
      name: 'log',
      async send() {
        attempts.push(Date.now());
        const step = script[Math.min(attempts.length - 1, script.length - 1)];
        if (step === 'transient') throw transientError();
        if (step === 'permanent') throw permanentError();
        if (step === 'unknown') throw new Error('weird provider bug');
        return { provider: 'log', messageId: 'msg-1' };
      },
    };
    const service = createEmailService({
      provider,
      fromAddress: 'noreply@feasly.example',
      fromName: 'Feasly',
      appBaseUrl: CTX.appBaseUrl,
      unsubscribeBaseUrl: CTX.unsubscribeBaseUrl,
      opsInbox: 'ops@feasly.example',
      ...opts,
    });
    return { service, attempts };
  }

  it('retries a transient failure and reports success when a later attempt lands', async () => {
    const { service, attempts } = scriptedService(['transient', 'ok']);
    const delivery = await service.sendMagicLink(MAGIC_INPUT);
    expect(attempts).toHaveLength(2);
    expect(delivery).toEqual({
      sent: true,
      provider: 'log',
      messageId: 'msg-1',
    });
  });

  it('exhausts attempts on persistent transient failure and returns the failure WITHOUT throwing', async () => {
    const { service, attempts } = scriptedService(['transient']);
    // Must not throw: the failure feeds the lead gate's
    // `magicLinkSent: false` + reportToken path.
    const delivery = await service.sendMagicLink(MAGIC_INPUT);
    expect(attempts).toHaveLength(3);
    expect(delivery.sent).toBe(false);
    if (!delivery.sent) {
      expect(delivery.provider).toBe('log');
      expect(delivery.emailError).toBe('delivery-failed');
      expect(delivery.failureReason.length).toBeGreaterThan(0);
    }
  });

  it('never retries a permanent invalid-recipient failure — one attempt, straight to the failure path', async () => {
    const { service, attempts } = scriptedService(['permanent']);
    const delivery = await service.sendMagicLink(MAGIC_INPUT);
    // A wrong email address must NOT be retried (Karan 2026-09-27).
    expect(attempts).toHaveLength(1);
    expect(delivery.sent).toBe(false);
    if (!delivery.sent) {
      expect(delivery.emailError).toBe('invalid-recipient');
    }
  });

  it('never re-sends an accepted-but-unconfirmed message — one attempt, acceptedByProvider set (P0 2026-09-27)', async () => {
    // ACS beginSend accepted the message, the delivery poll timed out:
    // re-sending would likely duplicate an already-delivered email
    // (Karan's triple "estimate is ready" emails). deliver() must NOT
    // retry, and must flag the acceptance so the lead service suppresses
    // resubmits.
    const attempts: number[] = [];
    const provider: EmailProvider = {
      name: 'acs',
      async send() {
        attempts.push(Date.now());
        throw new EmailProviderError(
          'Azure Communication Services email failed (delivery polling timed out after 6000ms).',
          { retryable: false, failureCode: 'delivery-failed', sendAccepted: true },
        );
      },
    };
    const service = createEmailService({
      provider,
      fromAddress: 'noreply@feasly.example',
      fromName: 'Feasly',
      appBaseUrl: CTX.appBaseUrl,
      unsubscribeBaseUrl: CTX.unsubscribeBaseUrl,
      opsInbox: 'ops@feasly.example',
    });
    const delivery = await service.sendMagicLink(MAGIC_INPUT);
    expect(attempts).toHaveLength(1);
    expect(delivery.sent).toBe(false);
    if (!delivery.sent) {
      expect(delivery.emailError).toBe('delivery-failed');
      expect(delivery.acceptedByProvider).toBe(true);
    }
  });

  it('retries unknown (non-provider) errors by default — never silently dropped as permanent', async () => {
    const { service, attempts } = scriptedService(['unknown']);
    const delivery = await service.sendMagicLink(MAGIC_INPUT);
    expect(attempts).toHaveLength(3);
    expect(delivery.sent).toBe(false);
    if (!delivery.sent) {
      expect(delivery.emailError).toBe('delivery-failed');
    }
  });

  it('honors a custom maxAttempts', async () => {
    const { service, attempts } = scriptedService(['transient'], {
      maxAttempts: 1,
    });
    const delivery = await service.sendMagicLink(MAGIC_INPUT);
    expect(attempts).toHaveLength(1);
    expect(delivery.sent).toBe(false);
  });

  it('backs off ~1s between attempts (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const { service, attempts } = scriptedService(['transient', 'ok']);
      const pending = service.sendMagicLink(MAGIC_INPUT);
      await vi.advanceTimersByTimeAsync(10_000);
      const delivery = await pending;
      expect(delivery.sent).toBe(true);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]! - attempts[0]!).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
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
      renderMagicLinkEmail(CTX, REPORT_INPUT),
      renderFollowUpEmail(CTX, FOLLOW_UP_INPUT),
      renderErasureConfirmationEmail(CTX, {
        name: 'Jane',
        confirmUrl: `${CTX.appBaseUrl}/privacy/confirm/x#token=y`,
        expiresInHours: 24,
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
      renderMagicLinkEmail(CTX, REPORT_INPUT),
      renderFollowUpEmail(CTX, FOLLOW_UP_INPUT),
    ].flatMap((r) => [r.subject, r.html, r.text]);
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

describe('postmark provider failure classification', () => {
  const MESSAGE = { to: 'a@b.example', subject: 's', html: 'h', text: 't' };

  function provider() {
    return createPostmarkEmailProvider({
      serverToken: 'test-token',
      fromAddress: 'noreply@feasly.example',
      endpoint: 'https://api.postmarkapp.com/email',
    });
  }

  function stubFetch(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('422 with an invalid-address ErrorCode is non-retryable invalid-recipient', async () => {
    stubFetch(422, {
      ErrorCode: 300,
      Message: "Invalid 'To' address: 'not-an-email'",
    });
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.retryable).toBe(false);
    expect(error.failureCode).toBe('invalid-recipient');
  });

  it('429 and 5xx rejections are retryable', async () => {
    for (const status of [429, 500, 503]) {
      stubFetch(status, { ErrorCode: 0, Message: 'busy' });
      const error = await provider().send(MESSAGE).catch((e) => e);
      expect(error.retryable).toBe(true);
      expect(error.failureCode).toBe('delivery-failed');
    }
  });

  it('a network failure is retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );
    const error = await provider().send(MESSAGE).catch((e) => e);
    expect(error.retryable).toBe(true);
    expect(error.failureCode).toBe('delivery-failed');
  });

  it('missing server token is non-retryable (permanent misconfiguration)', async () => {
    const unconfigured = createPostmarkEmailProvider({
      serverToken: undefined,
      fromAddress: 'noreply@feasly.example',
      endpoint: 'https://api.postmarkapp.com/email',
    });
    const error = await unconfigured.send(MESSAGE).catch((e) => e);
    expect(error.retryable).toBe(false);
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
    expect(config.email.opsInbox).toBe(SEED_ADMIN_EMAIL);
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

  it('email retry budget defaults to 3 attempts with a 7s ACS send bound', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.email.sendMaxAttempts).toBe(3);
    expect(config.email.acsSendTimeoutMs).toBe(7_000);
  });

  it('EMAIL_SEND_MAX_ATTEMPTS overrides the retry budget', () => {
    const config = loadConfig({ ...baseEnv, EMAIL_SEND_MAX_ATTEMPTS: '5' });
    expect(config.email.sendMaxAttempts).toBe(5);
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
