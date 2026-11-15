import { isPlatformServer } from '@angular/common';
import { inject, PLATFORM_ID } from '@angular/core';

/**
 * True when running on the server platform (dev-server SSR or build-time
 * prerender). Must be called in an injection context (e.g. a route guard).
 *
 * Client-state guards (wizard/report, issue #515) read localStorage-backed
 * NGXS state that does not exist on the server, so they let the server
 * render and leave the real decision to the browser after hydration —
 * otherwise a reload of `/estimate/*` in dev answers `302 → /`.
 */
export function isServerPlatform(): boolean {
  return isPlatformServer(inject(PLATFORM_ID));
}
