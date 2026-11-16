/**
 * #725 — builder new-lead email + daily "Needs you" digest templates.
 *
 * Privacy (owner decision 2026-11-15): first name, community, project type
 * and a deep link only — never the homeowner's email, phone or full name,
 * nothing identifying in the subject. No figures; no banned copy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderBuilderNeedsYouDigestEmail,
  renderBuilderNewLeadEmail,
  type RenderedEmail,
  type TemplateContext,
} from '../src/services/email/templates';

const CTX: TemplateContext = {
  appBaseUrl: 'https://app.feasly.example',
  unsubscribeBaseUrl: 'https://app.feasly.example/unsubscribe',
  brandName: 'Feasly',
};
const LEAD_ID = '11111111-1111-4111-8111-111111111111';

const BANNED = readFileSync(
  join(__dirname, '..', 'src', 'services', 'email', 'banned-patterns.txt'),
  'utf8',
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map((line) => new RegExp(line, 'i'));

function expectNoBannedCopy(rendered: RenderedEmail): void {
  for (const re of BANNED) {
    expect(rendered.subject + rendered.html + rendered.text).not.toMatch(re);
  }
}

function newLead(overrides?: { firstName?: string; community?: string }) {
  return renderBuilderNewLeadEmail(CTX, {
    firstName: overrides?.firstName ?? 'Jane',
    community: overrides?.community ?? 'Mount Pleasant',
    projectType: 'New build',
    builderName: 'Elite Craft Builders',
    leadId: LEAD_ID,
  });
}

describe('builder new-lead email (#725)', () => {
  it('names first name, community, project type, org and deep-links the lead', () => {
    const rendered = newLead();
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('Jane');
      expect(part).toContain('Mount Pleasant');
      expect(part).toContain('new build');
      expect(part).toContain('Elite Craft Builders');
      expect(part).toContain(`https://app.feasly.example/builder?open=${LEAD_ID}`);
      expect(part).toContain('notification preferences');
    }
    expect(rendered.html).toContain('Open lead');
  });

  it('keeps the name and contact details out of the subject line', () => {
    const rendered = newLead();
    expect(rendered.subject).toBe('New lead in Mount Pleasant');
    expect(rendered.subject).not.toContain('Jane');
    expect(rendered.subject).not.toMatch(/@|\d{3}-\d{4}/);
  });

  it('escapes HTML in interpolated values', () => {
    const rendered = newLead({ firstName: '<script>x</script>' });
    expect(rendered.html).not.toContain('<script>x</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('has no unsubscribe footer, figures or banned copy', () => {
    const rendered = newLead();
    expect(rendered.html.toLowerCase()).not.toContain('unsubscribe');
    expectNoBannedCopy(rendered);
  });
});

describe('builder "Needs you" digest email (#725)', () => {
  const line = (n: number) => ({ firstName: `Lead${n}`, waitingDays: n, leadId: `id-${n}` });

  it('lists each non-empty group with counts, first names, waiting time and links', () => {
    const rendered = renderBuilderNeedsYouDigestEmail(CTX, {
      builderName: 'Elite Craft Builders',
      uncontacted: [line(0), line(1)],
      stale: [line(9)],
      wonWithoutContract: [],
      staleAfterDays: 7,
      maxPerGroup: 10,
    });
    expect(rendered.subject).toBe('3 leads need you today');
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('Not contacted yet (2)');
      expect(part).toContain('No update in 7+ days (1)');
      expect(part).not.toContain('Won, contract not recorded');
      expect(part).toContain('Lead0');
      expect(part).toContain('waiting today');
      expect(part).toContain('waiting 1 day');
      expect(part).toContain('waiting 9 days');
      expect(part).toContain('https://app.feasly.example/builder?open=id-9');
    }
    expectNoBannedCopy(rendered);
  });

  it('caps each group and summarizes the rest; singular subject', () => {
    const many = renderBuilderNeedsYouDigestEmail(CTX, {
      builderName: 'Elite',
      uncontacted: [line(1), line(2), line(3)],
      stale: [],
      wonWithoutContract: [],
      staleAfterDays: 7,
      maxPerGroup: 2,
    });
    expect(many.text).toContain('and 1 more');
    expect(many.text).not.toContain('Lead3');
    const one = renderBuilderNeedsYouDigestEmail(CTX, {
      builderName: 'Elite',
      uncontacted: [],
      stale: [],
      wonWithoutContract: [line(4)],
      staleAfterDays: 7,
      maxPerGroup: 2,
    });
    expect(one.subject).toBe('1 lead needs you today');
    expect(one.text).toContain('Won, contract not recorded (1)');
  });
});
