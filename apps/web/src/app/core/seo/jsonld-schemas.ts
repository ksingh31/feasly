/**
 * Schema.org JSON-LD builders (SEO-06).
 *
 * Pure functions that build structured-data objects per page type. FAQ
 * answers are sourced from the same config copy as the rendered FAQ —
 * callers must pass `config.get('copy').marketing.faq.items` (or the
 * community FAQ items) so the drift test can assert byte-equality.
 *
 * No `null` values are ever emitted; optional fields (phone/address) are
 * omitted entirely until Karan provides public contact details.
 */

export interface FaqItem {
  readonly q: string;
  readonly a: string;
}

/** FAQPage with the given questions (≥3 required by the story). */
export function buildFaqPageSchema(items: readonly FaqItem[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/**
 * LocalBusiness for Feasly. `pageUrl` is the canonical URL of the page
 * carrying the schema. Phone/address are omitted (no invented contact
 * details — see SEO-06).
 */
export function buildLocalBusinessSchema(
  siteUrl: string,
  pageUrl: string,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: 'Feasly',
    url: pageUrl,
    areaServed: 'Calgary, AB',
    // The site itself as the publisher's web presence.
    sameAs: [`${siteUrl}/`],
  };
}

/** WebSite schema for the landing page. */
export function buildWebSiteSchema(
  siteUrl: string,
  description: string,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Feasly',
    url: `${siteUrl}/`,
    description,
    inLanguage: 'en-CA',
  };
}

/**
 * Asserts a built schema contains no `null` values (SEO-06 acceptance).
 * Throws on the first `null` found.
 */
export function assertNoNulls(value: unknown, path = '$'): void {
  if (value === null) {
    throw new Error(`JSON-LD contains null at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNulls(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      assertNoNulls(v, `${path}.${k}`);
    }
  }
}
