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

export const EstimateRequestSchema = EstimateInputsSchema.extend({
  addressKey: z.string().describe('Opaque property identifier from lookup'),
}).openapi('EstimateRequest');

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
  })
  .openapi('LeadRequest');

export const LeadResponseSchema = z
  .object({
    leadId: z.string(),
    magicLinkSent: z.boolean(),
    expiresInDays: z.number().int(),
  })
  .openapi('LeadResponse');

// ── Property ────────────────────────────────────────────────────────────

export const PropertyRecordSchema = z
  .object({
    addressKey: z.string(),
    address: z.string(),
    community: z.string(),
    lotSqft: z.number().describe('Lot size in square feet'),
    zoning: z.string().describe('City land-use designation, verbatim'),
    assessedValue: z.number().int().describe('City-assessed value, integer CAD'),
    assessmentYear: z.number().int(),
    yearBuilt: z.number().int().nullable(),
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
