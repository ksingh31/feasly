/**
 * OpenAPI 3.1 spec builder (api-mcp/03).
 *
 * Generates the spec from the zod schemas in `./schemas` using
 * `@asteasolutions/zod-to-openapi`. The spec is served at
 * `GET /api/v1/openapi.json` (public, no auth).
 *
 * `servers` uses the SITE_URL config (production) plus a sandbox placeholder.
 * The drift test regenerates this spec and fails on any diff — the spec
 * cannot drift from the schemas.
 */
import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  AnalyticsEventSchema,
  AnalyticsIngestResponseSchema,
  ApiErrorSchema,
  ApiKeyIssueRequestSchema,
  ApiKeyIssuedResponseSchema,
  ApiKeyListResponseSchema,
  ApiKeyScopeSchema,
  AutocompleteResponseSchema,
  CommunityStatsResponseSchema,
  CostRangeSchema,
  EmbedPublicConfigSchema,
  EstimateRequestSchema,
  EstimateResponseSchema,
  LeadRequestSchema,
  LeadResponseSchema,
  MagicLinkVerifyResponseSchema,
  PreviewEstimateResponseSchema,
  PrivacyEraseConfirmResponseSchema,
  PrivacyEraseRequestSchema,
  ProblemDetailsSchema,
  PropertyRecordSchema,
} from './schemas';

export interface OpenApiSpecOptions {
  /** Production site URL (from SITE_URL config). */
  readonly siteUrl: string;
  /** API version string (from package.json via config). */
  readonly version: string;
}

const PROBLEM_DETAILS_REF = '#/components/schemas/ProblemDetails';

/** Common error responses for every endpoint. */
function errorResponses() {
  return {
    '400': {
      description: 'Bad request — validation failed',
      content: {
        'application/problem+json': {
          schema: { $ref: PROBLEM_DETAILS_REF },
        },
      },
    },
    '429': {
      description: 'Rate limit exceeded',
      content: {
        'application/problem+json': {
          schema: { $ref: PROBLEM_DETAILS_REF },
        },
      },
    },
    '500': {
      description: 'Internal server error',
      content: {
        'application/problem+json': {
          schema: { $ref: PROBLEM_DETAILS_REF },
        },
      },
    },
  };
}

export function buildOpenApiSpec(options: OpenApiSpecOptions) {
  const registry = new OpenAPIRegistry();

  // Register all schemas as reusable components
  registry.register('CostRange', CostRangeSchema);
  registry.register('ApiError', ApiErrorSchema);
  registry.register('ProblemDetails', ProblemDetailsSchema);
  registry.register('EstimateRequest', EstimateRequestSchema);
  registry.register('EstimateResponse', EstimateResponseSchema);
  registry.register('PreviewEstimateResponse', PreviewEstimateResponseSchema);
  registry.register('LeadRequest', LeadRequestSchema);
  registry.register('LeadResponse', LeadResponseSchema);
  registry.register('PropertyRecord', PropertyRecordSchema);
  registry.register('AutocompleteResponse', AutocompleteResponseSchema);
  registry.register('ApiKeyScope', ApiKeyScopeSchema);
  registry.register('ApiKeyIssueRequest', ApiKeyIssueRequestSchema);
  registry.register('ApiKeyIssuedResponse', ApiKeyIssuedResponseSchema);
  registry.register('ApiKeyListResponse', ApiKeyListResponseSchema);
  registry.register('AnalyticsEvent', AnalyticsEventSchema);
  registry.register('AnalyticsIngestResponse', AnalyticsIngestResponseSchema);
  registry.register('EmbedPublicConfig', EmbedPublicConfigSchema);
  registry.register('CommunityStatsResponse', CommunityStatsResponseSchema);
  registry.register('MagicLinkVerifyResponse', MagicLinkVerifyResponseSchema);
  registry.register('PrivacyEraseRequest', PrivacyEraseRequestSchema);
  registry.register(
    'PrivacyEraseConfirmResponse',
    PrivacyEraseConfirmResponseSchema,
  );

  // ── Security schemes ──────────────────────────────────────────────
  registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'feasly_live_… / feasly_test_…',
    description:
      'API key issued via the admin endpoints. ' +
      'Send as `Authorization: Bearer <key>`. ' +
      'Sandbox keys (`feasly_test_…`) never trigger real emails.',
  });
  registry.registerComponent('securitySchemes', 'AdminKey', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Admin-Key',
    description:
      'Interim admin guard (pre-shared key). ' +
      'Being replaced by session auth (admin/01).',
  });

  // ── Public v1 endpoints ───────────────────────────────────────────

  // POST /v1/estimate
  registry.registerPath({
    method: 'post',
    path: '/v1/estimate',
    summary: 'Run a cost estimate',
    description:
      'Runs the deterministic cost engine on the given inputs. ' +
      'Returns real ranges (post-gate) — the pre-gate preview uses ' +
      'the blurred placeholder shape.',
    security: [{ ApiKeyAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': { schema: EstimateRequestSchema },
        },
      },
    },
    responses: {
      '200': {
        description: 'Estimate with real cost ranges',
        content: {
          'application/json': { schema: EstimateResponseSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // POST /v1/leads
  registry.registerPath({
    method: 'post',
    path: '/v1/leads',
    summary: 'Submit a lead',
    description:
      'Captures a lead and sends the magic-link email. ' +
      'The lead is persisted even if the link is never clicked.',
    security: [{ ApiKeyAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': { schema: LeadRequestSchema },
        },
      },
    },
    responses: {
      '201': {
        description: 'Lead captured',
        content: {
          'application/json': { schema: LeadResponseSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // GET /v1/embed/config
  registry.registerPath({
    method: 'get',
    path: '/v1/embed/config',
    summary: 'Get public embed config',
    description:
      'Returns the public builder config for an embed tenant ' +
      '(branding, contact fallbacks). No auth — public by design.',
    request: {
      query: z.object({
        key: z.string().describe('Tenant key from the embed snippet'),
      }),
    },
    responses: {
      '200': {
        description: 'Public embed config',
        content: {
          'application/json': { schema: EmbedPublicConfigSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // GET /v1/communities/{slug}/stats
  registry.registerPath({
    method: 'get',
    path: '/v1/communities/{slug}/stats',
    summary: 'Get community statistics',
    description: 'Aggregated City-assessment stats for a community page.',
    request: {
      params: z.object({
        slug: z.string().describe('Community slug (kebab-case)'),
      }),
    },
    responses: {
      '200': {
        description: 'Community stats',
        content: {
          'application/json': { schema: CommunityStatsResponseSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // POST /v1/events (analytics)
  registry.registerPath({
    method: 'post',
    path: '/v1/events',
    summary: 'Ingest analytics events',
    description:
      'First-party analytics ingest. Events require a valid consent_ts — ' +
      'the endpoint rejects payloads with missing or future-dated consent.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                events: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AnalyticsEvent' },
                },
              },
              required: ['events'],
            },
          },
        },
      },
    },
    responses: {
      '202': {
        description: 'Events accepted',
        content: {
          'application/json': { schema: AnalyticsIngestResponseSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // ── Admin API-key endpoints ───────────────────────────────────────

  const adminSecurity = [{ AdminKey: [] }];

  // POST /v1/admin/api-keys
  registry.registerPath({
    method: 'post',
    path: '/v1/admin/api-keys',
    summary: 'Issue an API key',
    description:
      'Issues a new API key. The plaintext is returned EXACTLY once — ' +
      'it is never stored and cannot be retrieved again.',
    security: adminSecurity,
    request: {
      body: {
        content: {
          'application/json': { schema: ApiKeyIssueRequestSchema },
        },
      },
    },
    responses: {
      '201': {
        description: 'Key issued (plaintext shown once)',
        content: {
          'application/json': { schema: ApiKeyIssuedResponseSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // GET /v1/admin/api-keys
  registry.registerPath({
    method: 'get',
    path: '/v1/admin/api-keys',
    summary: 'List API keys',
    description:
      'Lists API keys. Only masked prefixes are shown — never plaintext.',
    security: adminSecurity,
    responses: {
      '200': {
        description: 'Key list',
        content: {
          'application/json': { schema: ApiKeyListResponseSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // POST /v1/admin/api-keys/{id}/rotate
  registry.registerPath({
    method: 'post',
    path: '/v1/admin/api-keys/{id}/rotate',
    summary: 'Rotate an API key',
    description:
      'Rotates a key — the old plaintext is invalidated immediately, ' +
      'a new plaintext is returned once.',
    security: adminSecurity,
    request: {
      params: z.object({
        id: z.string().describe('Key ID (UUID)'),
      }),
    },
    responses: {
      '200': {
        description: 'Key rotated (new plaintext shown once)',
        content: {
          'application/json': { schema: ApiKeyIssuedResponseSchema },
        },
      },
      ...errorResponses(),
    },
  });

  // POST /v1/admin/api-keys/{id}/revoke
  registry.registerPath({
    method: 'post',
    path: '/v1/admin/api-keys/{id}/revoke',
    summary: 'Revoke an API key',
    description: 'Revokes a key immediately. Cannot be undone.',
    security: adminSecurity,
    request: {
      params: z.object({
        id: z.string().describe('Key ID (UUID)'),
      }),
    },
    responses: {
      '200': {
        description: 'Key revoked',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { revoked: { type: 'boolean' } },
            },
          },
        },
      },
      ...errorResponses(),
    },
  });

  // ── Generate ──────────────────────────────────────────────────────

  const generator = new OpenApiGeneratorV31(registry.definitions);

  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      version: options.version,
      title: 'Feasly Public API',
      description:
        'Address-aware infill feasibility estimates for Calgary. ' +
        'Deterministic cost engine — dollar figures are computed, never LLM-generated. ' +
        '\n\n' +
        '## Authentication\n' +
        'Public endpoints use API-key Bearer auth. Admin key endpoints use the interim `X-Admin-Key` header.\n' +
        '\n' +
        '## Rate limits\n' +
        'Per-key limits (default 100 req/min) plus per-endpoint IP limits. 429 responses use RFC 7807 problem+json.\n' +
        '\n' +
        '## Errors\n' +
        'All errors are RFC 7807 `application/problem+json` with a Feasly `code` and `correlationId`.\n' +
        '\n' +
        '## Versioning\n' +
        'URL versioning (`/v1/`). Breaking changes ship as `/v2/` with 6 months notice on v1.',
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: options.siteUrl, description: 'Production' },
      {
        url: 'https://api.sandbox.feasly.dev',
        description: 'Sandbox (test keys only, no real emails)',
      },
    ],
  });
}
