/**
 * Invitation email template tests (auth/01 — Entra pivot).
 *
 * Pins the buyer-grade copy: exact subject, single "Sign in to Feasly" CTA
 * to /admin/login, 7-day expiry note, plain-text fallback URL, and — since
 * Entra owns the credential — no password or token anywhere in the email.
 */
import { describe, expect, it } from 'vitest';
import {
  renderInvitationEmail,
  type TemplateContext,
} from '../src/services/email/templates';

const CTX: TemplateContext = {
  appBaseUrl: 'https://feasly.example',
  unsubscribeBaseUrl: 'https://feasly.example/unsubscribe',
  brandName: 'Feasly',
};

function render() {
  return renderInvitationEmail(CTX, {
    name: 'Ada Admin',
    signInUrl: 'https://feasly.example/admin/login',
    expiresInDays: 7,
    accessDescription: 'an admin',
    inviterName: 'Karan',
  });
}

describe('renderInvitationEmail', () => {
  it('uses the exact subject', () => {
    expect(render().subject).toBe("You've been invited to Feasly");
  });

  it('has one sign-in CTA pointing at /admin/login', () => {
    const { html } = render();
    const ctas = html.match(/Sign in to Feasly/g) ?? [];
    expect(ctas.length).toBe(1);
    expect(html).toContain('https://feasly.example/admin/login');
  });

  it('notes the 7-day expiry and the ready account', () => {
    const { html, text } = render();
    expect(html).toContain('expires in 7 days');
    expect(html).toContain('Your sign-in account is ready');
    expect(text).toContain('expires in 7 days');
  });

  it('carries no password or token copy', () => {
    const { html, text } = render();
    expect(html.toLowerCase()).not.toContain('password');
    expect(html.toLowerCase()).not.toContain('token');
    expect(text.toLowerCase()).not.toContain('password');
    expect(text.toLowerCase()).not.toContain('token');
  });

  it('includes the plain-text fallback URL', () => {
    const { text } = render();
    expect(text).toContain(
      'Sign in to Feasly: https://feasly.example/admin/login',
    );
  });

  it('personalizes with name and inviter', () => {
    const { html, text } = render();
    expect(html).toContain('Hi Ada Admin,');
    expect(html).toContain('Karan invited you');
    expect(text).toContain('Karan invited you');
  });

  it('escapes user-controlled fields', () => {
    const rendered = renderInvitationEmail(CTX, {
      name: '<script>alert(1)</script>',
      signInUrl: 'https://feasly.example/admin/login',
      expiresInDays: 7,
      accessDescription: 'an <b>admin</b>',
      inviterName: 'Ka"ran',
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).not.toContain('<b>admin</b>');
  });

  it('has no unsubscribe footer (team credential, transactional)', () => {
    const { html, text } = render();
    expect(html.toLowerCase()).not.toContain('unsubscribe');
    expect(text.toLowerCase()).not.toContain('unsubscribe');
  });
});
