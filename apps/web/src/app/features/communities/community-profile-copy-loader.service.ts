import { Injectable } from '@angular/core';
import type { RawCommunityProfileCopy } from '@feasly/contracts';

/**
 * Loads the community property-profile page copy on demand.
 *
 * The copy lives in `community-profile-copy.defaults.ts` and is reached
 * only through the dynamic `import()` below, so it ships in its own lazy
 * chunk — never in the initial bundle (Lighthouse script-size budget).
 * Only the profile variant (`CommunityPageComponent.renderProfile`) calls
 * this; every other page never triggers the load.
 *
 * Separated from the component so specs can substitute copy via TestBed
 * (the Angular unit-test builder does not support `vi.mock` for relative
 * imports).
 */
@Injectable({ providedIn: 'root' })
export class CommunityProfileCopyLoader {
  load(): Promise<RawCommunityProfileCopy> {
    return import('./community-profile-copy.defaults').then(
      (m) => m.DEFAULT_COMMUNITY_PROFILE_COPY,
    );
  }
}
