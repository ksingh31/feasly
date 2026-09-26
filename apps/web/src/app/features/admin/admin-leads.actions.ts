import type { AdminLeadFilters, AdminLeadStatus } from '@feasly/contracts';

/** Which tab of the leads explorer is visible. */
export type AdminLeadsTab = 'all' | 'quarantine';

/** Reload the list from the first page with new filters/tab. */
export class LoadAdminLeads {
  static readonly type = '[AdminLeads] Load';
  constructor(
    readonly filters: AdminLeadFilters = {},
    readonly tab: AdminLeadsTab = 'all',
  ) {}
}

/** Fetch the next cursor page and append it. */
export class LoadMoreAdminLeads {
  static readonly type = '[AdminLeads] Load more';
}

/** Open the detail drawer for a lead. */
export class SelectAdminLead {
  static readonly type = '[AdminLeads] Select lead';
  constructor(readonly id: string) {}
}

/** Close the detail drawer. */
export class ClearSelectedAdminLead {
  static readonly type = '[AdminLeads] Clear selected lead';
}

/** Append a note to the selected lead (append-only). */
export class AddAdminLeadNote {
  static readonly type = '[AdminLeads] Add note';
  constructor(
    readonly id: string,
    readonly note: string,
  ) {}
}

/** Transition a lead's pipeline status. */
export class UpdateAdminLeadStatus {
  static readonly type = '[AdminLeads] Update status';
  constructor(
    readonly id: string,
    readonly status: AdminLeadStatus,
  ) {}
}

/** Download the CSV export of the current filtered set. */
export class ExportAdminLeadsCsv {
  static readonly type = '[AdminLeads] Export CSV';
}

/** Switch between the all-leads and quarantine tabs. */
export class SetAdminLeadsTab {
  static readonly type = '[AdminLeads] Set tab';
  constructor(readonly tab: AdminLeadsTab) {}
}

/** Include/exclude sandbox rows (badged "Sandbox", excluded by default). */
export class ToggleAdminLeadsSandbox {
  static readonly type = '[AdminLeads] Toggle sandbox';
  constructor(readonly include: boolean) {}
}
