/**
 * Sheets column layout (admin/04, #814): every row value has a header, and
 * the write range spans exactly the header width — the range was
 * hardcoded to A:R (18 columns) while rows had 20 values.
 */
import { describe, expect, it } from 'vitest';
import {
  LAST_COLUMN,
  SHEET_HEADERS,
  columnLetter,
  rowToValues,
} from '../src/services/sheets/google-sheets-client';
import type { SheetLeadRow } from '../src/services/sheets/sheets-client';

const ROW: SheetLeadRow = {
  leadId: 'lead-1',
  name: 'Jane',
  email: 'jane@example.com',
  phone: '',
  timeline: 'exploring',
  leadScore: 50,
  status: 'new',
  projectType: 'new_build',
  address: 'addr',
  sqft: null,
  tier: '',
  rangeLow: null,
  rangeHigh: null,
  consentTs: '2026-11-16T00:00:00.000Z',
  marketingConsent: true,
  contactConsent: 'in',
  consentUpdatedAt: '2026-11-16T00:00:00.000Z',
  tenant: '',
  source: 'web',
  createdAt: '2026-11-16T00:00:00.000Z',
  utmSource: 'google',
  utmMedium: 'cpc',
  utmCampaign: 'spring',
  utmTerm: 'infill',
  utmContent: 'ad-a',
  clickIdType: 'gclid',
};

describe('google sheets columns', () => {
  it('converts column indexes to letters', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(18)).toBe('R');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(52)).toBe('AZ');
  });

  it('row values line up one-to-one with the headers', () => {
    const values = rowToValues(ROW);
    expect(values).toHaveLength(SHEET_HEADERS.length);
    const byHeader = Object.fromEntries(SHEET_HEADERS.map((h, i) => [h, values[i]]));
    expect(byHeader).toMatchObject({
      lead_id: 'lead-1',
      created_at: '2026-11-16T00:00:00.000Z',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring',
      utm_term: 'infill',
      utm_content: 'ad-a',
      click_id_type: 'gclid',
    });
  });

  it('keeps the pre-#814 columns in place (attribution appended)', () => {
    expect(SHEET_HEADERS.indexOf('created_at')).toBe(19);
    expect(SHEET_HEADERS.slice(20)).toEqual([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'click_id_type',
    ]);
  });

  it('the write range spans the full header width', () => {
    expect(LAST_COLUMN).toBe(columnLetter(SHEET_HEADERS.length));
    expect(LAST_COLUMN).toBe('Z');
  });
});
