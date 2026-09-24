import { inject } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import type { CanActivateFn } from '@angular/router';

/**
 * Robots guard (QA audit P2): `/estimate/*` wizard routes are app state with
 * thin near-duplicate content — they carry `noindex` so crawl budget stays on
 * landing + content pages. Routes opt in via `data: { noindex: true }`; every
 * other guarded route removes the tag (back-navigation safe).
 */
export const robotsGuard: CanActivateFn = (route) => {
  const meta = inject(Meta);
  if (route.data['noindex'] === true) {
    meta.updateTag({ name: 'robots', content: 'noindex' });
  } else {
    meta.removeTag('name="robots"');
  }
  return true;
};
