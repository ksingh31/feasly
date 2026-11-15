import type { AdminSearchHitKind } from '@feasly/contracts';

/**
 * Where an admin record lives (#538). Pure — no Angular. Every EntityLink
 * and ⌘K hit navigates through this one map, so a record kind always
 * opens the same place.
 *
 * List pages that show records in a drawer/modal read the `open` query
 * parameter (`?open=<id>`, portal-ui-kit §3 Drawer: URL-synced).
 */
export const ADMIN_OPEN_PARAM = 'open';

export interface AdminEntityTarget {
  readonly commands: readonly string[];
  readonly queryParams?: Readonly<Record<string, string>>;
}

export function adminEntityTarget(kind: AdminSearchHitKind, id: string): AdminEntityTarget {
  switch (kind) {
    case 'lead':
      return { commands: ['/admin/leads'], queryParams: { [ADMIN_OPEN_PARAM]: id } };
    case 'invoice':
      return { commands: ['/admin/billing/invoices'], queryParams: { [ADMIN_OPEN_PARAM]: id } };
    case 'builder':
      return { commands: ['/admin/builders'], queryParams: { [ADMIN_OPEN_PARAM]: id } };
    case 'user':
      return { commands: ['/admin/users'], queryParams: { [ADMIN_OPEN_PARAM]: id } };
  }
}

/** Minimal router surface, so this file stays free of Angular imports. */
interface Navigator {
  navigate(commands: unknown[], extras?: { queryParams?: Record<string, string> }): Promise<boolean>;
}

/** Navigate to a record (EntityLink `opened` handlers, ⌘K hits). */
export function openAdminEntity(router: Navigator, kind: AdminSearchHitKind, id: string): void {
  const target = adminEntityTarget(kind, id);
  void router.navigate([...target.commands], { queryParams: target.queryParams });
}
