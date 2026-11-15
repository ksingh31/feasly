import { inject } from '@angular/core';
import { Router, type RedirectFunction } from '@angular/router';

/**
 * `/builder/record-contract` (and the older `/builder/report-contract`)
 * retired in #529: contracts are recorded from the lead drawer's Won panel.
 * Redirects to the Leads home; `?lead=<id>` becomes `?open=<id>` so the
 * drawer opens on that lead. Eager-safe: no builder copy or state imports.
 */
export const recordContractRedirect: RedirectFunction = ({ queryParams }) => {
  const lead = queryParams['lead'];
  const open = typeof lead === 'string' && lead.length > 0 ? lead : null;
  return inject(Router).createUrlTree(['/builder'], {
    queryParams: open ? { open } : {},
  });
};
