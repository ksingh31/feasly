import { describe, expect, it } from 'vitest';
import {
  assertNoNulls,
  buildFaqPageSchema,
  buildLocalBusinessSchema,
  buildWebSiteSchema,
  type FaqItem,
} from './jsonld-schemas';

const FAQ_ITEMS: FaqItem[] = [
  { q: 'What is Feasly?', a: 'A build-cost estimator.' },
  { q: 'How much does it cost?', a: 'It depends on the tier.' },
  { q: 'Where do you operate?', a: 'Calgary, AB.' },
  { q: 'How accurate?', a: 'Calibrated against builder data.' },
  { q: 'What is a magic link?', a: 'Passwordless report unlock.' },
];

describe('buildFaqPageSchema', () => {
  it('builds a FAQPage with all questions', () => {
    const schema = buildFaqPageSchema(FAQ_ITEMS);
    expect(schema['@type']).toBe('FAQPage');
    const entities = schema['mainEntity'] as { name: string }[];
    expect(entities).toHaveLength(5);
    expect(entities[0].name).toBe('What is Feasly?');
  });

  it('byte-matches the source copy (drift guard)', () => {
    const schema = buildFaqPageSchema(FAQ_ITEMS);
    const entities = schema['mainEntity'] as {
      acceptedAnswer: { text: string };
    }[];
    // Every answer in the schema must be byte-identical to the source copy.
    FAQ_ITEMS.forEach((item, i) => {
      expect(entities[i].acceptedAnswer.text).toBe(item.a);
    });
  });

  it('emits no null values', () => {
    expect(() => assertNoNulls(buildFaqPageSchema(FAQ_ITEMS))).not.toThrow();
  });
});

describe('buildLocalBusinessSchema', () => {
  it('has the required Feasly fields', () => {
    const schema = buildLocalBusinessSchema('https://feasly.ca', 'https://feasly.ca/communities/beltline');
    expect(schema['@type']).toBe('LocalBusiness');
    expect(schema['name']).toBe('Feasly');
    expect(schema['areaServed']).toBe('Calgary, AB');
    expect(schema['url']).toBe('https://feasly.ca/communities/beltline');
  });

  it('omits phone and address entirely (no invented contact details)', () => {
    const schema = buildLocalBusinessSchema('https://feasly.ca', 'https://feasly.ca/');
    expect('telephone' in schema).toBe(false);
    expect('phone' in schema).toBe(false);
    expect('address' in schema).toBe(false);
    // Also assert the serialized form has no such keys.
    const json = JSON.stringify(schema);
    expect(json).not.toContain('telephone');
    expect(json).not.toContain('"address"');
  });

  it('emits no null values', () => {
    expect(() => assertNoNulls(buildLocalBusinessSchema('https://feasly.ca', 'https://feasly.ca/'))).not.toThrow();
  });
});

describe('buildWebSiteSchema', () => {
  it('builds a WebSite with canonical URL', () => {
    const schema = buildWebSiteSchema('https://feasly.ca', 'Estimate your build cost.');
    expect(schema['@type']).toBe('WebSite');
    expect(schema['name']).toBe('Feasly');
    expect(schema['url']).toBe('https://feasly.ca/');
    expect(schema['inLanguage']).toBe('en-CA');
  });

  it('emits no null values', () => {
    expect(() => assertNoNulls(buildWebSiteSchema('https://feasly.ca', 'desc'))).not.toThrow();
  });
});

describe('assertNoNulls', () => {
  it('throws on null anywhere in the tree', () => {
    expect(() => assertNoNulls({ a: { b: null } })).toThrow(/null at \$\.a\.b/);
    expect(() => assertNoNulls([1, null])).toThrow(/null at \$\[1\]/);
  });
});
