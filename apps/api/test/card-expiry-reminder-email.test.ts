/**
 * #880 — one-time card-expiry reminder email template.
 */
import { describe, expect, it } from 'vitest';
import {
  renderCardExpiryReminderEmail,
  type TemplateContext,
} from '../src/services/email/templates';

const CTX: TemplateContext = {
  appBaseUrl: 'https://app.feasly.example',
  unsubscribeBaseUrl: 'https://app.feasly.example/unsubscribe',
  brandName: 'Feasly',
};

const INPUT = {
  businessName: 'Elite Craft Builders',
  brand: 'visa',
  last4: '4242',
  expMonth: 12,
  expYear: 2026,
};

describe('card-expiry reminder template (#880)', () => {
  it('names the card and expiry month and links the replace-card path in the portal', () => {
    const r = renderCardExpiryReminderEmail(CTX, INPUT);
    expect(r.subject).toBe('Your Visa ending in 4242 expires soon — replace your card');
    for (const body of [r.html, r.text]) {
      expect(body).toContain('Elite Craft Builders');
      expect(body).toContain('4242');
      expect(body).toContain('December 2026');
      expect(body).toContain('https://app.feasly.example/builder/billing');
      expect(body).toContain('Replace card');
      expect(body).toContain('one-time reminder');
    }
  });

  it('escapes the business name in HTML', () => {
    const r = renderCardExpiryReminderEmail(CTX, { ...INPUT, businessName: '<b>Acme & Co</b>' });
    expect(r.html).not.toContain('<b>Acme');
    expect(r.html).toContain('&lt;b&gt;Acme &amp; Co&lt;/b&gt;');
  });

  it('labels unknown brands readably and carries no banned copy', () => {
    const r = renderCardExpiryReminderEmail(CTX, { ...INPUT, brand: 'amex' });
    expect(r.subject).toContain('American Express');
    const all = `${r.subject}\n${r.html}\n${r.text}`.toLowerCase();
    for (const banned of ['guarantee', 'appraisal', 'market value', 'unlock']) {
      expect(all).not.toContain(banned);
    }
  });
});
