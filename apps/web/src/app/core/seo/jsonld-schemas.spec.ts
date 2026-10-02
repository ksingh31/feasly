import { describe, expect, it } from 'vitest';
import {
  assertNoNulls,
  buildArticleSchema,
  buildFaqPageSchema,
  buildHowToSchema,
  buildItemListSchema,
  buildLocalBusinessSchema,
  buildWebSiteSchema,
  type FaqItem,
  type HowToStepInput,
  type ItemListEntry,
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

describe('buildItemListSchema', () => {
  const entries: ItemListEntry[] = [
    { name: 'Beltline, Calgary', url: 'https://feasly.ca/communities/beltline/' },
    { name: 'Bowness, Calgary', url: 'https://feasly.ca/communities/bowness/' },
  ];

  it('builds an ItemList with positioned entries', () => {
    const schema = buildItemListSchema('https://feasly.ca/communities/', entries);
    expect(schema['@type']).toBe('ItemList');
    expect(schema['url']).toBe('https://feasly.ca/communities/');
    expect(schema['numberOfItems']).toBe(2);
    const items = schema['itemListElement'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      '@type': 'ListItem',
      position: 1,
      name: 'Beltline, Calgary',
      url: 'https://feasly.ca/communities/beltline/',
    });
    expect(items[1]).toMatchObject({ position: 2 });
  });

  it('emits no null values', () => {
    expect(() =>
      assertNoNulls(buildItemListSchema('https://feasly.ca/communities/', entries)),
    ).not.toThrow();
  });
});

describe('buildHowToSchema', () => {
  const steps: HowToStepInput[] = [
    { title: 'Enter your Calgary address', body: 'We pull your City property record.' },
    { title: 'Configure your scope', body: 'Tell us about the project.' },
  ];

  it('builds a HowTo mirroring the visible steps', () => {
    const schema = buildHowToSchema(
      'https://feasly.ca/how-it-works/',
      'From address to estimate in about 2 minutes',
      'No account, no phone calls.',
      steps,
    );
    expect(schema['@type']).toBe('HowTo');
    expect(schema['url']).toBe('https://feasly.ca/how-it-works/');
    const rendered = schema['step'] as Record<string, unknown>[];
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({
      '@type': 'HowToStep',
      position: 1,
      name: 'Enter your Calgary address',
      text: 'We pull your City property record.',
    });
  });

  it('emits no null values', () => {
    expect(() =>
      assertNoNulls(buildHowToSchema('https://feasly.ca/how-it-works/', 't', 'd', steps)),
    ).not.toThrow();
  });
});

describe('buildArticleSchema', () => {
  const imageUrl = 'https://feasly.ca/assets/og/og-default.png';

  it('builds an Article with Feasly as author/publisher', () => {
    const schema = buildArticleSchema(
      'https://feasly.ca',
      'https://feasly.ca/guides/cost-to-build-a-house-calgary/',
      'How much does it cost to build a house in Calgary?',
      'Planning ranges for building a house in Calgary.',
      imageUrl,
    );
    expect(schema['@type']).toBe('Article');
    expect(schema['headline']).toBe('How much does it cost to build a house in Calgary?');
    expect(schema['url']).toBe('https://feasly.ca/guides/cost-to-build-a-house-calgary/');
    expect(schema['author']).toMatchObject({ '@type': 'Organization', name: 'Feasly' });
    expect(schema['inLanguage']).toBe('en-CA');
  });

  it('emits an absolute image URL (Article rich-result eligibility)', () => {
    const schema = buildArticleSchema(
      'https://feasly.ca',
      'https://feasly.ca/guides/calgary-zoning-explained/',
      'Calgary Zoning Explained',
      'What R-C1, R-C2, R-CG mean.',
      imageUrl,
    );
    expect(schema['image']).toBe(imageUrl);
    expect(typeof schema['image']).toBe('string');
    expect(schema['image'] as string).toMatch(/^https:\/\//);
  });

  it('emits no null values', () => {
    expect(() =>
      assertNoNulls(buildArticleSchema('https://feasly.ca', 'https://feasly.ca/g/', 'h', 'd', imageUrl)),
    ).not.toThrow();
  });
});

describe('assertNoNulls', () => {
  it('throws on null anywhere in the tree', () => {
    expect(() => assertNoNulls({ a: { b: null } })).toThrow(/null at \$\.a\.b/);
    expect(() => assertNoNulls([1, null])).toThrow(/null at \$\[1\]/);
  });
});
