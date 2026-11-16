/**
 * Sheets write range (#927): the update/append ranges were hardcoded to
 * A:R (18 columns) while rows carry one value per SHEET_HEADERS entry (20),
 * so the Sheets API would reject updates to existing rows. The range is now
 * derived from the header width — this pins it against the real client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sheetsApi = vi.hoisted(() => ({
  get: vi.fn(),
  batchUpdate: vi.fn(),
  append: vi.fn(),
  spreadsheetsGet: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: vi.fn() },
    sheets: () => ({
      spreadsheets: {
        get: sheetsApi.spreadsheetsGet,
        values: {
          get: sheetsApi.get,
          batchUpdate: sheetsApi.batchUpdate,
          append: sheetsApi.append,
        },
      },
    }),
  },
}));

import {
  LAST_COLUMN,
  SHEET_HEADERS,
  columnLetter,
  createGoogleSheetsClient,
  rowToValues,
} from '../src/services/sheets/google-sheets-client';
import type { SheetLeadRow } from '../src/services/sheets/sheets-client';

function row(leadId: string): SheetLeadRow {
  return {
    leadId,
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
    utmSource: '',
    utmMedium: '',
    utmCampaign: '',
    utmTerm: '',
    utmContent: '',
    clickIdType: '',
  };
}

function client() {
  return createGoogleSheetsClient({
    sheetId: 'sheet-1',
    serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
    privateKey: 'test-key',
    apiScope: 'https://www.googleapis.com/auth/spreadsheets',
  });
}

describe('google sheets client write range', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sheetsApi.get.mockResolvedValue({ data: { values: [['existing']] } });
    sheetsApi.batchUpdate.mockResolvedValue({});
    sheetsApi.append.mockResolvedValue({});
  });

  it('converts column indexes to letters', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(18)).toBe('R');
    expect(columnLetter(20)).toBe('T');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(52)).toBe('AZ');
  });

  it('row values line up one-to-one with the headers', () => {
    expect(rowToValues(row('lead-1'))).toHaveLength(SHEET_HEADERS.length);
    expect(LAST_COLUMN).toBe(columnLetter(SHEET_HEADERS.length));
  });

  it('updates and appends span exactly the header width', async () => {
    await client().upsertRows([row('existing'), row('new-lead')]);

    const update = sheetsApi.batchUpdate.mock.calls[0]?.[0];
    expect(update.requestBody.data).toHaveLength(1);
    const data = update.requestBody.data[0];
    expect(data.range).toBe(`A2:${LAST_COLUMN}2`);
    expect(data.values[0]).toHaveLength(SHEET_HEADERS.length);

    const append = sheetsApi.append.mock.calls[0]?.[0];
    expect(append.range).toBe(`A2:${LAST_COLUMN}`);
    expect(append.requestBody.values).toHaveLength(1);
    expect(append.requestBody.values[0]).toHaveLength(SHEET_HEADERS.length);
    // 26 headers today (#814 utm columns) → column Z, not the old hardcoded R.
    expect(LAST_COLUMN).not.toBe('R');
  });
});
