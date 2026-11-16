/**
 * Zod schemas for OpenAPI spec generation (api-mcp/03).
 *
 * These mirror the `@feasly/contracts` TypeScript interfaces. The contracts
 * package is the source of truth for shapes; these zod schemas are the
 * OpenAPI generation source — they must stay in sync. The drift test
 * (test/openapi.drift.test.ts) regenerates the spec and fails on diff,
 * which catches shape drift at CI time.
 *
 * Naming: `*Schema` suffix, matching the contract name where possible.
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// ── Common ──────────────────────────────────────────────────────────────

export const CostRangeSchema = z
  .object({
    low: z.number().int().describe('Lower bound, integer CAD (no cents)'),
    base: z
      .number()
      .int()
      .describe('Deterministic best estimate (low <= base <= high)'),
    high: z.number().int().describe('Upper bound, integer CAD (no cents)'),
  })
  .openapi('CostRange');

export const FixedFigureSchema = z
  .object({
    value: z.number().int().describe('Fixed CAD figure, integer (no cents)'),
  })
  .openapi('FixedFigure');

export const ApiErrorSchema = z
  .object({
    code: z.string().describe('Machine-readable error code'),
    message: z.string().describe('Human-readable message'),
    retryable: z
      .boolean()
      .describe('Whether the UI should offer a Retry button'),
  })
  .openapi('ApiError');

// RFC 7807 Problem Details (the actual error envelope on the wire)
export const ProblemDetailsSchema = z
  .object({
    type: z.string().describe('URI identifying the problem type'),
    title: z.string().describe('Short human-readable summary'),
    status: z.number().int().describe('HTTP status code'),
    detail: z.string().optional().describe('Detailed explanation'),
    code: z.string().describe('Feasly error code (see error-code catalog)'),
    correlationId: z.string().describe('Request correlation ID for support'),
  })
  .openapi('ProblemDetails');

// ── Estimate ────────────────────────────────────────────────────────────

export const FinishTierSchema = z
  .enum(['standard', 'premium', 'luxury'])
  .openapi('FinishTier');
export const GarageOptionSchema = z
  .enum(['none', 'double', 'triple'])
  .openapi('GarageOption');
export const BasementOptionSchema = z
  .enum(['unfinished', 'finished'])
  .openapi('BasementOption');

export const EstimateInputsSchema = z
  .object({
    sqft: z.number().positive().describe('Living area in square feet'),
    tier: FinishTierSchema,
    garage: GarageOptionSchema,
    basement: BasementOptionSchema,
  })
  .openapi('EstimateInputs');

export const EstimatePropertySchema = z
  .object({
    addressKey: z
      .string()
      .describe('Opaque property identifier from lookup'),
    assessedLandValue: z
      .number()
      .int()
      .positive()
      .describe('City-assessed land value, integer CAD'),
    lotSizeSqft: z
      .number()
      .int()
      .positive()
      .describe('Lot size in square feet'),
    zoning: z.string().describe('Zoning code, e.g. R-CG'),
  })
  .openapi('EstimateProperty');

export const EstimateScopeSchema = z
  .object({
    buildSqft: z
      .number()
      .int()
      .positive()
      .describe('Above-grade living area in square feet'),
    tier: FinishTierSchema,
    garage: GarageOptionSchema,
    basement: BasementOptionSchema,
  })
  .openapi('EstimateScope');

/**
 * Canonical new-build estimate request (2026-09-26).
 *
 * This mirrors the service's Zod validation in
 * `src/services/estimate.service.ts` (`NewBuildRequestSchema`) — the nested
 * `{ property, scope }` shape is what the live API accepts. The previous
 * flat `{ addressKey, sqft, tier, ... }` shape was stale and would 400.
 */
export const EstimateRequestSchema = z
  .object({
    projectType: z
      .literal('new_build')
      .optional()
      .describe("Discriminator; defaults to 'new_build' when absent"),
    property: EstimatePropertySchema,
    scope: EstimateScopeSchema,
  })
  .openapi('EstimateRequest');

export const CostRowSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    range: CostRangeSchema,
  })
  .openapi('CostRow');

export const PreviewEstimateResponseSchema = z
  .object({
    estimateId: z.string(),
    addressKey: z.string(),
    inputs: EstimateInputsSchema,
    figures: z.object({
      build: CostRangeSchema.describe('Real computed build range — UI renders blurred pre-gate'),
      total: CostRangeSchema.describe('Real computed total range — UI renders blurred pre-gate'),
      land: FixedFigureSchema.describe('Fixed City assessed land value — UI renders blurred pre-gate'),
    }),
    rows: z
      .array(z.unknown())
      .max(0)
      .describe('Always empty pre-gate'),
    costDataVersion: z.string(),
    createdAt: z.string().datetime(),
  })
  .openapi('PreviewEstimateResponse');

export const EstimateResponseSchema = z
  .object({
    estimateId: z.string(),
    addressKey: z.string(),
    inputs: EstimateInputsSchema,
    figures: z.object({
      build: CostRangeSchema,
      total: CostRangeSchema,
      land: FixedFigureSchema.describe(
        'City-assessed land value — a fixed fact, never a range',
      ),
    }),
    rows: z.array(CostRowSchema),
    costDataVersion: z.string(),
    createdAt: z.string().datetime(),
    projectType: z.enum(['new_build', 'renovation']).optional(),
    disclaimer: z
      .string()
      .describe(
        'Approved deterministic-math disclaimer, verbatim on every estimate response (HRD-05)',
      ),
  })
  .openapi('EstimateResponse');

// ── Lead ────────────────────────────────────────────────────────────────

export const TimelineOptionSchema = z
  .enum(['0-3mo', '3-6mo', '6-12mo', '12+mo', 'exploring'])
  .openapi('TimelineOption');

export const LeadRequestSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1),
    phone: z.string().optional(),
    timeline: TimelineOptionSchema,
    marketingConsent: z
      .boolean()
      .describe('CASL marketing consent (unchecked by default in UI)'),
    estimateId: z.string(),
    tenantKey: z
      .string()
      .optional()
      .describe('Present only on builder embeds'),
    website: z
      .string()
      .optional()
      .describe('Honeypot anti-spam field — leave empty'),
    elapsedMs: z
      .number()
      .optional()
      .describe(
        'Milliseconds the form was on screen before submit (browser clients). Optional for API callers.',
      ),
  })
  .openapi('LeadRequest');

export const LeadResponseSchema = z
  .object({
    leadId: z.string(),
    magicLinkSent: z.boolean(),
    expiresInDays: z.number().int(),
    emailError: z
      .enum(['invalid-recipient', 'delivery-failed'])
      .optional()
      .describe(
        'Why the magic-link email failed — present only when magicLinkSent is false',
      ),
    emailAlreadySent: z
      .boolean()
      .optional()
      .describe(
        'True when no new email was sent because one already went out recently for this email + property (idempotent resubmit)',
      ),
  })
  .openapi('LeadResponse');

// ── Property ────────────────────────────────────────────────────────────

export const PropertyLandUseSchema = z
  .object({
    district: z.string().describe("Land-use district code, e.g. 'R-C2', 'DC'"),
    description: z.string().describe('City description of the district; empty when unknown'),
    source: z
      .enum(['land-use-districts', 'assessment-roll'])
      .describe(
        "'land-use-districts' = the City's current Land Use Districts map; 'assessment-roll' = fallback to the assessment roll designation",
      ),
    asOf: z.string().describe('When the district was checked against the source (ISO date)'),
    dcBylaw: z
      .string()
      .optional()
      .describe('Direct Control bylaw number when district is DC and the City provides one'),
  })
  .describe('Current land-use district for a parcel and where it came from')
  .openapi('PropertyLandUse');

export const PropertyRecordSchema = z
  .object({
    addressKey: z.string(),
    address: z.string(),
    community: z.string(),
    lotSqft: z.number().describe('Lot size in square feet'),
    zoning: z
      .string()
      .describe(
        'City land-use designation: the current district (landUse.district) when known, otherwise the assessment roll value verbatim',
      ),
    landUse: PropertyLandUseSchema.optional(),
    assessedValue: z.number().int().describe('City-assessed value, integer CAD'),
    assessmentYear: z
      .number()
      .int()
      .describe('Assessment roll year; a fallback (current year) when assessmentYearInferred is true'),
    assessmentYearInferred: z
      .boolean()
      .optional()
      .describe('True when the City row had no roll year and assessmentYear is a fallback'),
    yearBuilt: z.number().int().nullable(),
    steer: z
      .object({
        redevelopmentCandidate: z
          .boolean()
          .nullable()
          .describe('True when the home is at/over the redevelopment age threshold; null when the year built is unknown'),
        reason: z.enum(['age_at_or_over_threshold', 'age_under_threshold', 'year_built_unknown']),
        recommendedProjectType: z
          .enum(['new_build', 'renovation'])
          .nullable()
          .describe('Project type offered first; null = no steering'),
        homeAgeYears: z.number().int().nullable(),
        thresholdYears: z.number().int().describe('Market redevelopment age threshold, in years'),
      })
      .optional()
      .describe('Project-type steer by home age (#755); absent = no steering'),
    assessmentClass: z.string().describe("City assessment class code, verbatim (e.g. 'R', 'NR')"),
    isNonResidential: z
      .boolean()
      .describe('True when the City classifies the parcel non-residential (commercial/industrial)'),
    dataAsOf: z.string().describe('When the City data was fetched (ISO date)'),
    stale: z
      .boolean()
      .describe('True when assessment year is older than freshness threshold'),
  })
  .openapi('PropertyRecord');

export const AutocompleteSuggestionSchema = z
  .object({
    addressKey: z.string(),
    address: z.string(),
    community: z.string(),
  })
  .openapi('AutocompleteSuggestion');

export const AutocompleteResponseSchema = z
  .object({
    suggestions: z.array(AutocompleteSuggestionSchema),
  })
  .openapi('AutocompleteResponse');

// ── API Keys (admin) ────────────────────────────────────────────────────

export const ApiKeyScopeSchema = z
  .enum(['property:read', 'estimate', 'estimate:read', 'lead', 'lead:read'])
  .openapi('ApiKeyScope');

export const ApiKeyIssueRequestSchema = z
  .object({
    name: z.string().min(1).describe('Human-readable label'),
    tenant_id: z.string().optional().describe('Optional tenant binding'),
    scopes: z.array(ApiKeyScopeSchema).optional(),
    rate_limit: z.number().int().positive().optional(),
    sandbox: z
      .boolean()
      .optional()
      .describe('True for feasly_test_ keys (no emails sent)'),
  })
  .openapi('ApiKeyIssueRequest');

export const ApiKeyRecordResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tenant_id: z.string().nullable(),
    key_prefix: z
      .string()
      .describe('Masked display form — never the full key'),
    scopes: z.array(ApiKeyScopeSchema),
    rate_limit_per_min: z.number().int(),
    sandbox: z.boolean(),
    revoked_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('ApiKeyRecordResponse');

export const ApiKeyIssuedResponseSchema = z
  .object({
    key: ApiKeyRecordResponseSchema,
    plaintext: z
      .string()
      .describe('Plaintext key — returned EXACTLY once, never again'),
  })
  .openapi('ApiKeyIssuedResponse');

export const ApiKeyListResponseSchema = z
  .object({
    keys: z.array(ApiKeyRecordResponseSchema),
  })
  .openapi('ApiKeyListResponse');

// ── Analytics events ────────────────────────────────────────────────────

export const AnalyticsEventNameSchema = z
  .enum([
    'step_view',
    'gate_view',
    'gate_convert',
    'report_open',
    'tier_toggle',
    'callback_request',
    'partner_share',
    'pdf_download',
    'embed_loaded',
    'report_resume',
    'report_link_request',
    'report_link_copy',
    'report_link_share',
    'steer_new_build_offered',
    'steer_renovation_offered',
    'steer_none_offered',
    'steer_override_new_build',
  ])
  .openapi('AnalyticsEventName');

export const AnalyticsEventSchema = z
  .object({
    event: AnalyticsEventNameSchema,
    route: z.string().describe('Client route where the event occurred'),
    ts: z.string().datetime().describe('Client-side occurrence timestamp'),
    consent_ts: z
      .string()
      .datetime()
      .describe('Consent-banner acknowledgement timestamp'),
  })
  .openapi('AnalyticsEvent');

export const AnalyticsIngestResponseSchema = z
  .object({
    accepted: z.number().int().describe('Number of events accepted'),
  })
  .openapi('AnalyticsIngestResponse');

// ── Embed config ────────────────────────────────────────────────────────

export const EmbedPublicConfigSchema = z
  .object({
    business_name: z.string(),
    display_name: z.string(),
    logo_url: z.string().describe("May be '' — falls back to Feasly wordmark"),
    accent_color: z.string().describe('Hex color (#rrggbb)'),
    allowed_origins: z.array(z.string()),
    fallback_phone: z.string(),
    fallback_email: z.string(),
    plan: z.enum(['flat', 'commission']).nullable(),
  })
  .openapi('EmbedPublicConfig');

// ── Community stats ─────────────────────────────────────────────────────

export const CommunityStatsResponseSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    count: z.number().int().describe('Assessment record count'),
    avgAssessedValue: z.number().int().describe('Average City-assessed value'),
    avgLotSqft: z.number().describe('Average lot size in square feet'),
  })
  .openapi('CommunityStatsResponse');

// ── Community lot inventory (#691) ──────────────────────────────────────

export const CommunityLotSchema = z
  .object({
    rollNumber: z.string().min(1).describe('City assessment roll number'),
    address: z.string().min(1).describe('Street address as published by the City'),
    lotSqft: z.number().int().nullable().describe('Lot area in square feet; null when unknown'),
    assessedValue: z
      .number()
      .int()
      .describe('City-assessed value, whole CAD (not market value, not a Feasly estimate)'),
    rollYear: z.string().describe('Assessment roll year of the value'),
    district: z.string().nullable().describe('Current land-use district, e.g. R-CG'),
    districtSource: z.enum(['land-use-districts', 'assessment-roll']),
    kind: z.enum(['vacant', 'candidate']),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    firstSeenAt: z.string().datetime().describe('When Feasly first listed the lot'),
  })
  .strict()
  .openapi('CommunityLot');

export const CommunityLotsResponseSchema = z
  .object({
    community: z.object({ slug: z.string(), name: z.string() }).strict(),
    city: z.string(),
    refreshedAt: z.string().datetime(),
    stale: z.boolean().describe('True when the refresh is older than the configured threshold'),
    total: z.number().int().nonnegative().describe('Lots matching the filters, across all pages'),
    lots: z.array(CommunityLotSchema),
    nextCursor: z.string().nullable().describe('Opaque cursor for the next page; null on the last'),
  })
  .strict()
  .openapi('CommunityLotsResponse');

// ── City-data freshness ────────────────────────────────────────────────

export const CityDataFreshnessResponseSchema = z
  .object({
    refreshedMonth: z
      .string()
      .nullable()
      .describe(
        'Month + year the assessment dataset was last refreshed ("September 2026"); ' +
          'null when the Socrata metadata could not be read.',
      ),
    rollYear: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        'Latest assessment roll year in the dataset (e.g. 2026); null when it could not be read.',
      ),
  })
  .openapi('CityDataFreshnessResponse');

// ── Builder partners (#888) ─────────────────────────────────────────────

export const BuilderPartnerSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().describe('Builder company name (never an individual)'),
    logoUrl: z.string().nullable().describe('Hosted logo URL, or null'),
    websiteUrl: z.string().nullable().describe('Company website (https), or null'),
    description: z
      .string()
      .nullable()
      .describe('Short description / community focus, or null'),
  })
  .openapi('BuilderPartner');

export const BuilderPartnerListResponseSchema = z
  .object({
    partners: z
      .array(BuilderPartnerSchema)
      .describe('Active builder partners in display order'),
  })
  .openapi('BuilderPartnerListResponse');

// ── Zoning rules catalogue (#687) ───────────────────────────────────────

const BUILDING_FORM_VALUES = [
  'single-detached',
  'semi-detached',
  'duplex',
  'rowhouse',
  'townhouse',
  'secondary-suite',
  'backyard-suite',
  'multi-residential',
] as const;

export const BuildingFormSchema = z
  .enum(BUILDING_FORM_VALUES)
  .describe('Building form from the fixed vocabulary.')
  .openapi('BuildingForm');

const ZoningCategorySchema = z.enum([
  'low-density',
  'grade-oriented',
  'multi-residential',
  'mixed-use',
  'direct-control',
  'non-residential',
]);
const ZoningCoverageSchema = z
  .enum(['covered', 'site-specific', 'not-covered'])
  .describe(
    'covered: forms/rules listed; site-specific: Direct Control (see the DC bylaw); ' +
      'not-covered: a known district Feasly does not describe.',
  );
const FormPermissionSchema = z.enum(['permitted', 'discretionary']);
const BylawSectionSchema = z.string().min(1).describe('Bylaw section reference, e.g. "s. 385(1)(b)".');

const zoningRuleShape = {
  value: z.number().nonnegative(),
  section: BylawSectionSchema,
  note: z.string().min(1).optional(),
};

/** Public (verified-only) rule: no `verified` flag on the wire. */
const ZoningRuleSchema = z.object(zoningRuleShape).strict();
/** Source rule: every value carries `verified`. */
const ZoningRuleSourceSchema = z.object({ ...zoningRuleShape, verified: z.boolean() }).strict();

const zoningFormShape = {
  form: BuildingFormSchema,
  permission: FormPermissionSchema,
  section: BylawSectionSchema,
  note: z.string().min(1).optional(),
};

function keyRules<T extends z.ZodTypeAny>(rule: T) {
  return z
    .object({
      maxHeightM: rule.optional().describe('Maximum building height, metres.'),
      maxLotCoveragePct: rule.optional().describe('Maximum parcel coverage, per cent of parcel area.'),
      maxDensityUnitsPerHa: rule.optional().describe('Maximum density, units per hectare.'),
      maxUnitsOnLot: rule.optional().describe('Fixed maximum number of units on a lot.'),
    })
    .strict();
}

const zoningDistrictShape = {
  code: z.string().min(1),
  name: z.string().min(1),
  category: ZoningCategorySchema,
  coverage: ZoningCoverageSchema,
  note: z.string().min(1).optional(),
};

export const ZoningDistrictSchema = z
  .object({
    ...zoningDistrictShape,
    aliases: z.array(z.string().min(1)),
    forms: z.array(z.object(zoningFormShape).strict()),
    rules: keyRules(ZoningRuleSchema).describe(
      'Verified key rules only; an absent rule means "see the City\'s bylaw".',
    ),
  })
  .strict()
  .openapi('ZoningDistrict');

const zoningVersionShape = {
  city: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('ISO date the rules took effect.'),
  bylaw: z.string().min(1),
  bylawVersion: z.string().min(1).describe('Which text of the bylaw the sections were read from.'),
  sourceUrl: z.string().url().describe("The City's bylaw page — where to confirm the rules."),
};

export const ZoningDistrictsResponseSchema = z
  .object({ ...zoningVersionShape, districts: z.array(ZoningDistrictSchema) })
  .strict()
  .openapi('ZoningDistrictsResponse');

/**
 * Source catalogue (`ZoningRulesVersion`): what a data file in
 * @feasly/zoning must satisfy. Not served; validated in tests.
 */
export const ZoningRulesVersionSchema = z
  .object({
    ...zoningVersionShape,
    districts: z.array(
      z
        .object({
          ...zoningDistrictShape,
          aliases: z.array(z.string().min(1)).optional(),
          forms: z.array(z.object({ ...zoningFormShape, verified: z.boolean() }).strict()),
          rules: keyRules(ZoningRuleSourceSchema),
        })
        .strict(),
    ),
  })
  .strict();

// ── Magic link ──────────────────────────────────────────────────────────

export const MagicLinkVerifyResponseSchema = z
  .object({
    verified: z.boolean(),
    estimateId: z.string().optional(),
  })
  .openapi('MagicLinkVerifyResponse');

// ── Privacy ─────────────────────────────────────────────────────────────

export const PrivacyEraseRequestSchema = z
  .object({
    email: z.string().email(),
  })
  .openapi('PrivacyEraseRequest');

export const PrivacyEraseConfirmResponseSchema = z
  .object({
    erased: z.boolean(),
  })
  .openapi('PrivacyEraseConfirmResponse');

export const NarrativeResponseSchema = z
  .object({
    estimateId: z.string().uuid(),
    narrative: z.string(),
    narrativeGeneratedAt: z.string().datetime(),
    cached: z.boolean(),
    narrativeSource: z.enum(['ai', 'static-guide']),
  })
  .openapi('NarrativeResponse');
// ── Admin estimate lookup (admin/03) ─────────────────────────────────────

export const AdminEstimateSnapshotRefSchema = z
  .object({
    id: z.string().uuid().describe('The estimate lookup id'),
    createdAt: z.string().datetime().describe('Snapshot creation time'),
  })
  .openapi('AdminEstimateSnapshotRef');

export const AdminEstimateDetailSchema = z
  .object({
    id: z.string().uuid(),
    projectType: z.enum(['new_build', 'renovation']),
    inputs: z.record(z.string(), z.unknown()).describe('Wizard inputs as submitted'),
    outputs: z
      .object({
        buildRange: CostRangeSchema,
        totalRange: CostRangeSchema,
        landValue: z.object({ value: z.number() }),
      })
      .describe('Report-parity figures: same shape the consumer report shows'),
    rows: z.array(z.record(z.string(), z.unknown())),
    costDataVersion: z.string(),
    narrative: z
      .string()
      .nullable()
      .describe('Present only when a narrative was generated; never invented'),
    createdAt: z.string().datetime(),
    linkedLeadId: z.string().uuid().nullable(),
    snapshots: z
      .array(AdminEstimateSnapshotRefSchema)
      .describe('Same-address snapshot timeline, newest first'),
  })
  .openapi('AdminEstimateDetail');

// ── Report snapshots (phase-2 wiring) ─────────────────────────────────────

export const RenoEstimateInputsSchema = z
  .object({
    projectType: z.literal('renovation'),
    renoType: z.enum(['extensive', 'addition', 'basement', 'combined']),
    renoSqft: z.number().int().positive(),
    tier: FinishTierSchema,
    underpinning: z.boolean(),
  })
  .openapi('RenoEstimateInputs');

export const ReportSnapshotSchema = z
  .object({
    snapshotId: z.string().uuid(),
    estimateId: z.string().uuid(),
    leadId: z.string().uuid(),
    addressKey: z
      .string()
      .optional()
      .describe('Property the estimate was run for — lets a fresh device hydrate the report'),
    inputs: EstimateInputsSchema,
    buildRange: CostRangeSchema,
    totalRange: CostRangeSchema,
    landValue: FixedFigureSchema.describe(
      'City-assessed land value — a fixed fact, never a range',
    ),
    rows: z.array(CostRowSchema),
    narrative: z.string(),
    preparedAt: z.string().datetime(),
    version: z.number().int().min(1),
    updatedAt: z
      .string()
      .datetime()
      .optional()
      .describe(
        'Set when an old magic link resolved to a newer snapshot or a revision was appended',
      ),
    projectType: z.string().optional(),
    renoInputs: RenoEstimateInputsSchema.optional(),
    assumptions: z.array(z.string()).optional(),
  })
  .openapi('ReportSnapshot');

export const TierRevisionRequestSchema = z
  .object({
    tier: FinishTierSchema.optional(),
    sqft: z.number().int().positive().max(20000).optional(),
  })
  .openapi('TierRevisionRequest')
  .describe('At least one of tier or sqft is required');

// ── Callback requests (phase-2 wiring) ──────────────────────────────────

export const CallbackWindowSchema = z
  .enum(['morning', 'afternoon', 'evening'])
  .openapi('CallbackWindow');

export const CallbackRequestSchema = z
  .object({
    reportToken: z.string().describe('The magic-link report token (Bearer <redacted>)'),
    name: z.string().min(1).max(120),
    phone: z.string().min(7).max(32),
    window: CallbackWindowSchema,
  })
  .openapi('CallbackRequest');

export const CallbackResponseSchema = z
  .object({
    ok: z.literal(true),
    window: CallbackWindowSchema,
  })
  .openapi('CallbackResponse');

// ── Waitlist signups (#520) ─────────────────────────────────────────────

export const WaitlistTopicSchema = z
  .enum(['renovation', 'toronto', 'vancouver'])
  .openapi('WaitlistTopic');

export const WaitlistRequestSchema = z
  .object({
    email: z.string().email().max(254),
    topic: WaitlistTopicSchema,
    /** CASL express consent — the required checkbox. */
    consent: z.literal(true),
  })
  .openapi('WaitlistRequest');

export const WaitlistResponseSchema = z
  .object({
    ok: z.literal(true),
    topic: WaitlistTopicSchema,
  })
  .openapi('WaitlistResponse');

// ── Partner shares (phase-2 wiring) ─────────────────────────────────────

export const PartnerShareRequestSchema = z
  .object({
    reportToken: z.string().describe('The owner magic-link report token (Bearer <redacted>)'),
    partnerEmail: z.string().email().max(254),
  })
  .openapi('PartnerShareRequest');

export const PartnerShareResponseSchema = z
  .object({
    sent: z.boolean().describe(
      'Whether the email provider accepted the message (log channel until ACS is provisioned)',
    ),
    sharedTo: z.string().email(),
  })
  .openapi('PartnerShareResponse');

export const PartnerShareVerifyResponseSchema = z
  .object({
    valid: z.boolean(),
    reportToken: z.string().optional(),
    estimateId: z.string().optional(),
    partnerEmail: z.string().email().optional(),
    reason: z.enum(['expired', 'invalid']).optional(),
  })
  .openapi('PartnerShareVerifyResponse');
