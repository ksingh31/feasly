import type { BuilderCreateBody, BuilderUpdateBody } from '@feasly/contracts';

/** Load the full builders table into state. */
export class LoadBuilders {
  static readonly type = '[AdminBuilders] Load';
}

/** Create a builder row (`tenantKey` immutable after creation). */
export class CreateBuilder {
  static readonly type = '[AdminBuilders] Create';
  constructor(readonly body: BuilderCreateBody) {}
}

/** Update a builder row (`tenantKey` cannot change). */
export class UpdateBuilder {
  static readonly type = '[AdminBuilders] Update';
  constructor(
    readonly id: string,
    readonly body: BuilderUpdateBody,
  ) {}
}

/** Dismiss the inline load error. */
export class DismissBuildersError {
  static readonly type = '[AdminBuilders] Dismiss load error';
}

/** Dismiss the inline save error. */
export class DismissBuildersSaveError {
  static readonly type = '[AdminBuilders] Dismiss save error';
}

/** Dismiss the "saved" confirmation. */
export class DismissBuildersSaved {
  static readonly type = '[AdminBuilders] Dismiss saved';
}

/**
 * Assign a lead to a builder (`builderId: null` unassigns).
 * The caller refetches the lead detail for the updated `builderId`.
 */
export class AssignLeadBuilder {
  static readonly type = '[AdminBuilders] Assign lead';
  constructor(
    readonly leadId: string,
    readonly builderId: string | null,
  ) {}
}

/** Dismiss the inline assign error on the lead detail. */
export class DismissAssignBuilderError {
  static readonly type = '[AdminBuilders] Dismiss assign error';
}
