/**
 * Which consumer a search belongs to. The ⌘K palette and the lead picker
 * (create-invoice) keep separate result sets so one never shows the
 * other's stale hits.
 */
export type AdminSearchScope = 'palette' | 'leadPicker';

/** Run an admin global search (an empty query clears the scope). */
export class SearchAdmin {
  static readonly type = '[AdminSearch] Search';
  constructor(
    readonly scope: AdminSearchScope,
    readonly query: string,
  ) {}
}

/** Forget a scope's query and hits (palette closed, picker reset). */
export class ClearAdminSearch {
  static readonly type = '[AdminSearch] Clear';
  constructor(readonly scope: AdminSearchScope) {}
}
