/**
 * #814 — campaign-source validation/mapping (pure lib).
 */
import { describe, expect, it } from 'vitest';
import {
  AnalyticsSourceSchema,
  CLICK_ID_TYPES,
  EMPTY_CAMPAIGN_SOURCE,
  columnsToSource,
  sanitizeLeadSource,
  sourceToColumns,
} from '../src/lib/campaign-source';

describe('campaign source', () => {
  it('accepts plain campaign values, including non-ASCII letters', () => {
    const parsed = AnalyticsSourceSchema.safeParse({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'Infill_2026-Q4 (YYC)',
      utm_term: 'maison neuve calgary',
      utm_content: 'ad|v2:hero/a+b~c.d',
      click_id_type: 'gbraid',
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['email', { utm_term: 'jane@example.com' }],
    ['dollar figure', { utm_content: '$500000' }],
    ['query fragment', { utm_source: 'a=b' }],
    ['percent-encoding', { utm_source: 'a%40b' }],
    ['over-length', { utm_source: 'x'.repeat(101) }],
    ['empty', { utm_source: '   ' }],
    ['unknown key', { referrer: 'example.com' }],
    ['unknown click id type', { click_id_type: 'dclid' }],
  ])('rejects %s', (_label, value) => {
    expect(AnalyticsSourceSchema.safeParse(value).success).toBe(false);
  });

  it('allows exactly 100 characters', () => {
    expect(AnalyticsSourceSchema.safeParse({ utm_source: 'x'.repeat(100) }).success).toBe(
      true,
    );
  });

  it('click id types are the contract union', () => {
    expect([...CLICK_ID_TYPES].sort()).toEqual(
      ['fbclid', 'gbraid', 'gclid', 'msclkid', 'wbraid'],
    );
  });

  it('sanitizeLeadSource keeps valid fields and drops the rest', () => {
    expect(
      sanitizeLeadSource({
        utm_source: ' google ',
        utm_medium: 'jane@example.com',
        utm_campaign: 7,
        click_id_type: 'msclkid',
        gclid: 'value',
      }),
    ).toEqual({
      ...EMPTY_CAMPAIGN_SOURCE,
      utmSource: 'google',
      clickIdType: 'msclkid',
    });
  });

  it.each([undefined, null, 'google', 42, ['google']])(
    'sanitizeLeadSource treats %j as no attribution',
    (raw) => {
      expect(sanitizeLeadSource(raw)).toEqual(EMPTY_CAMPAIGN_SOURCE);
    },
  );

  it('round-trips through the column shape with only set fields', () => {
    const source = { utm_source: 'google', utm_campaign: 'spring', click_id_type: 'gclid' as const };
    expect(columnsToSource(sourceToColumns(source))).toEqual(source);
    expect(columnsToSource(sourceToColumns(undefined))).toBeNull();
  });
});
