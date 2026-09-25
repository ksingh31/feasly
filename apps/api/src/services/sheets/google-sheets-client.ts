/**
 * Google Sheets API implementation of SheetsClient (admin/04).
 *
 * Uses the service account (credentials from Key Vault via config) to
 * upsert lead rows. The Sheet has a header row; column A is the lead ID
 * (the upsert key). New IDs append; existing IDs replace their row.
 *
 * Fail-closed: if the Sheet ID or service-account email is empty, the
 * factory throws — the worker catches this at startup and alerts instead
 * of syncing.
 */
import { google, sheets_v4 } from 'googleapis';
import type { SheetLeadRow, SheetsClient } from './sheets-client';

export interface GoogleSheetsClientDeps {
  /** Destination Sheet ID (from config). */
  readonly sheetId: string;
  /** Service-account email (from config/Key Vault). */
  readonly serviceAccountEmail: string;
  /** Service-account private key (from Key Vault via config). */
  readonly privateKey: string;
  /** OAuth scope (from config). */
  readonly apiScope: string;
}

/** Header row — column order is the contract with the Sheet. */
export const SHEET_HEADERS = [
  'lead_id',
  'name',
  'email',
  'phone',
  'timeline',
  'lead_score',
  'status',
  'project_type',
  'address',
  'sqft',
  'tier',
  'range_low',
  'range_high',
  'consent_ts',
  'marketing_consent',
  'tenant',
  'source',
  'created_at',
] as const;

function rowToValues(row: SheetLeadRow): string[] {
  return [
    row.leadId,
    row.name,
    row.email,
    row.phone,
    row.timeline,
    String(row.leadScore),
    row.status,
    row.projectType,
    row.address,
    row.sqft === null ? '' : String(row.sqft),
    row.tier,
    row.rangeLow === null ? '' : String(row.rangeLow),
    row.rangeHigh === null ? '' : String(row.rangeHigh),
    row.consentTs,
    row.marketingConsent ? 'TRUE' : 'FALSE',
    row.tenant,
    row.source,
    row.createdAt,
  ];
}

export function createGoogleSheetsClient(
  deps: GoogleSheetsClientDeps,
): SheetsClient {
  const { sheetId, serviceAccountEmail, privateKey, apiScope } = deps;

  if (!sheetId) {
    throw new Error('SHEETS_SHEET_ID is not configured');
  }
  if (!serviceAccountEmail) {
    throw new Error('SHEETS_SERVICE_ACCOUNT_EMAIL is not configured');
  }
  if (!privateKey) {
    throw new Error('Sheets service-account private key is not configured');
  }

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: [apiScope],
  });
  const sheets: sheets_v4.Sheets = google.sheets({ version: 'v4', auth });

  return {
    async checkAccess(): Promise<void> {
      // A cheap metadata call — fails if the Sheet doesn't exist or the
      // service account lacks access.
      await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    },

    async upsertRows(rows: readonly SheetLeadRow[]): Promise<void> {
      if (rows.length === 0) return;

      // Read column A to find existing lead IDs and their row numbers.
      const idColumn = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'A2:A',
      });
      const existingIds = new Map<string, number>();
      const values = idColumn.data.values ?? [];
      for (let i = 0; i < values.length; i++) {
        const id = values[i]?.[0];
        if (typeof id === 'string' && id.length > 0) {
          // Sheet rows are 1-indexed; A2 is row 2.
          existingIds.set(id, i + 2);
        }
      }

      const updates: sheets_v4.Schema$ValueRange[] = [];
      const appends: string[][] = [];

      for (const row of rows) {
        const values = rowToValues(row);
        const existingRow = existingIds.get(row.leadId);
        if (existingRow !== undefined) {
          // Replace the entire row (A:R for 18 columns).
          updates.push({
            range: `A${existingRow}:R${existingRow}`,
            values: [values],
          });
        } else {
          appends.push(values);
        }
      }

      // Batch the updates.
      if (updates.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: updates,
          },
        });
      }

      // Append new rows.
      if (appends.length > 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: sheetId,
          range: 'A2:R',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: appends },
        });
      }
    },
  };
}
