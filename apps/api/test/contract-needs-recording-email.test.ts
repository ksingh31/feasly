/**
 * Issue #530 — "Needs recording" email template (lead marked won by a
 * teammate; an org admin is asked to record the signed contract).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderContractNeedsRecordingEmail,
  type TemplateContext,
} from '../src/services/email/templates';

const CTX: TemplateContext = {
  appBaseUrl: 'https://app.feasly.example',
  unsubscribeBaseUrl: 'https://app.feasly.example/unsubscribe',
  brandName: 'Feasly',
};

const LEAD_ID = '11111111-1111-4111-8111-111111111111';

function render(overrides?: { readonly leadName?: string }) {
  return renderContractNeedsRecordingEmail(CTX, {
    markedBy: 'member@elite.example',
    leadName: overrides?.leadName ?? 'Jane Doe',
    address: '123 Main St SW',
    builderName: 'Elite Craft Builders',
    leadId: LEAD_ID,
  });
}

describe('contract-needs-recording template (#530)', () => {
  it('names the teammate, lead, address and org, and links to record-contract', () => {
    const rendered = render();
    expect(rendered.subject).toBe('Needs recording: Jane Doe was marked won');
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('member@elite.example');
      expect(part).toContain('Jane Doe');
      expect(part).toContain('123 Main St SW');
      expect(part).toContain('Elite Craft Builders');
      expect(part).toContain(
        `https://app.feasly.example/builder/record-contract?lead=${LEAD_ID}`,
      );
    }
    expect(rendered.html).toContain('Record contract');
    // Transactional org notice: no unsubscribe footer, no figures.
    expect(rendered.html).not.toContain('unsubscribe');
    expect(rendered.text).not.toMatch(/\$\s?\d/);
  });

  it('escapes HTML in user-supplied names', () => {
    const rendered = render({ leadName: '<script>x</script>' });
    expect(rendered.html).not.toContain('<script>x</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('renders no banned copy patterns', () => {
    const patterns = readFileSync(
      join(__dirname, '..', 'src', 'services', 'email', 'banned-patterns.txt'),
      'utf8',
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => new RegExp(line, 'i'));
    const rendered = render();
    for (const re of patterns) {
      expect(rendered.subject + rendered.html + rendered.text).not.toMatch(re);
    }
  });
});
