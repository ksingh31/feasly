import type {
  BuilderCreateBody,
  BuilderExportKind,
  BuilderLifecycleAction,
  BuilderUpdateBody,
} from '@feasly/contracts';

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

/** Dismiss the inline assign success confirmation on the lead detail. */
export class DismissAssignBuilderSuccess {
  static readonly type = '[AdminBuilders] Dismiss assign success';
}

/**
 * Load one builder's detail for the drawer's platform-agreement block
 * (#722: GET /admin/builders/{id} → `agreement`).
 */
export class LoadAdminBuilderAgreement {
  static readonly type = '[AdminBuilders] Load builder agreement';
  constructor(readonly id: string) {}
}

/**
 * Lifecycle action on one builder (#861): suspend · reactivate · start or
 * complete offboarding, with the admin's mandatory reason. The result lands
 * in `lifecycleFeedback`; on success the builder row is replaced.
 */
export class ChangeBuilderStatus {
  static readonly type = '[AdminBuilders] Change status';
  constructor(
    readonly id: string,
    readonly action: BuilderLifecycleAction,
    readonly reason: string,
  ) {}
}

/** Clear the last lifecycle result (the modal read it). */
export class DismissBuilderLifecycleFeedback {
  static readonly type = '[AdminBuilders] Dismiss lifecycle feedback';
}

/** Load what blocks "complete offboarding" for one builder (#861 checklist). */
export class LoadOffboardingBlockers {
  static readonly type = '[AdminBuilders] Load offboarding blockers';
  constructor(readonly id: string) {}
}

/** Download one builder's leads or invoices CSV (#861 hand-over export). */
export class ExportBuilderData {
  static readonly type = '[AdminBuilders] Export builder data';
  constructor(
    readonly id: string,
    readonly kind: BuilderExportKind,
  ) {}
}

/** Dismiss the inline export error in the builder drawer. */
export class DismissBuilderExportError {
  static readonly type = '[AdminBuilders] Dismiss export error';
}
