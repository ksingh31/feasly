import type { BuilderPartnerCreateBody, BuilderPartnerUpdateBody } from '@feasly/contracts';

/**
 * Admin builder-partner actions (#919). All page state lives in
 * AdminPartnersState — the page and drawer dispatch these and read
 * selectors; they never call the API directly.
 */

/** Load every partner (active and inactive) in display order. */
export class LoadAdminPartners {
  static readonly type = '[AdminPartners] Load';
}

/** Add a partner. Errors re-throw so the drawer can stay open. */
export class CreateAdminPartner {
  static readonly type = '[AdminPartners] Create';
  constructor(public readonly body: BuilderPartnerCreateBody) {}
}

/** Edit a partner's details. Errors re-throw so the drawer can stay open. */
export class UpdateAdminPartner {
  static readonly type = '[AdminPartners] Update';
  constructor(
    public readonly id: string,
    public readonly body: BuilderPartnerUpdateBody,
  ) {}
}

/** Turn a partner on or off in the public list. */
export class SetAdminPartnerActive {
  static readonly type = '[AdminPartners] Set active';
  constructor(
    public readonly id: string,
    public readonly active: boolean,
  ) {}
}

/** Move a partner one place up (-1) or down (+1) in the display order. */
export class MoveAdminPartner {
  static readonly type = '[AdminPartners] Move';
  constructor(
    public readonly id: string,
    public readonly direction: -1 | 1,
  ) {}
}

/** Clear the drawer's save error (on open). */
export class ClearAdminPartnerSaveError {
  static readonly type = '[AdminPartners] Clear save error';
}
