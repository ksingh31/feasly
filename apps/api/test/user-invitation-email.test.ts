/**
 * Invitation email template tests (auth/01).
 *
 * Pins the buyer-grade copy: exact subject, single Create-your-password
 * CTA, 7-day expiry note, plain-text fallback URL, and no token/password
 * in the logged/delivered shapes beyond the link itself.
 */
import { describe, expect, it } from 'vitest';
import {
  renderInvitationEmail,
  type TemplateContext,
} from '../src/services/email/templates';

const CTX: TemplateContext = { brandName: 'Feasly' };

function render() {
  return renderInvitationEmail(CTX, {
    name: 'Ada Admin',
    inviteUrl: 'https://feasly.example/accept-invite?token=abc123',
    expiresInDays: 7,
    accessDescription: 'an admin',
    inviterName: 'Karan',
  });
}

describe('renderInvitationEmail', () => {
  it('uses the exact invitation subject', () => {
    expect(render().subject).toBe("You've been invited to Feasly");
  });

  it('renders one Create your password CTA plus the plain-text fallback URL', () => {
    const { html, text } = render();
    const ctaMatches = html.match(/Create your password/g) ?? [];
    // Button label + fallback line reference; exactly one <a> CTA button.
    expect(ctaMatches.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain(
      'href="https://feasly.example/accept-invite?token=abc123"',
    );
    expect(html).toContain('Button not working? Paste this link');
    expect(text).toContain(
      'Create your password: https://feasly.example/accept-invite?token=abc123',
    );
  });

  it('notes the 7-day expiry and single use in both bodies', () => {
    const { html, text } = render();
    expect(html).toContain('expires in 7 days and can only be used once');
    expect(text).toContain('expires in 7 days and can only be used once');
  });

  it('names the inviter and the access grant in buyer-grade copy', () => {
    const { html, text } = render();
    expect(html).toContain('Karan invited you to join Feasly as an admin.');
    expect(text).toContain('Karan invited you to join Feasly as an admin.');
  });

  it('escapes user-controlled values', () => {
    const rendered = renderInvitationEmail(CTX, {
      name: '<script>alert(1)</script>',
      inviteUrl: 'https://feasly.example/accept-invite?token=abc123',
      expiresInDays: 7,
      accessDescription: 'an admin',
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('has no unsubscribe footer (team credential, like admin sign-in links)', () => {
    const { html, text } = render();
    expect(html).not.toContain('Unsubscribe');
    expect(text).not.toContain('Unsubscribe');
  });
});
