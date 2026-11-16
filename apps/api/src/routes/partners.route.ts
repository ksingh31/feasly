/**
 * Thin public builder-partner route (#888).
 *
 * - GET /api/v1/partners — public. Active builder partners (the companies
 *   that receive leads from Feasly's own site) in display order:
 *   `{ partners: [{ id, name, logoUrl, websiteUrl, description }] }`.
 *   Cached in the service; the adapter adds a public Cache-Control.
 *
 * Hard rules (enforced by test/boundaries.test.ts): no db/, no process.env,
 * depends on the service interface only.
 */
import type { BuilderPartnerListResponse } from '@feasly/contracts';
import type { BuilderPartnersService } from '../services/builder-partners.service';

export interface PartnersRouteDeps {
  readonly partners: BuilderPartnersService;
}

export interface PartnersRoute {
  /** GET /api/v1/partners */
  list(): Promise<BuilderPartnerListResponse>;
}

export function createPartnersRoute(deps: PartnersRouteDeps): PartnersRoute {
  return {
    async list(): Promise<BuilderPartnerListResponse> {
      return { partners: await deps.partners.listPublic() };
    },
  };
}
