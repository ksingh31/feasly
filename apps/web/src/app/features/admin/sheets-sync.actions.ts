/**
 * Sheets sync ops actions (admin/05). All Sheets sync panel state lives in
 * SheetsSyncState — components dispatch and render selectors, never call
 * the API directly.
 */

/** Load the current worker status (last run/success, pending, failures). */
export class LoadSheetsSyncStatus {
  static readonly type = '[SheetsSync] Load status';
}

/**
 * Trigger one manual worker run ("Sync now"). The panel disables the button
 * while a run is in flight (run_in_flight) or a trigger is pending; a 409
 * from the API refreshes the status so the panel shows the in-flight run.
 */
export class TriggerSheetsSyncNow {
  static readonly type = '[SheetsSync] Trigger sync now';
}
