/**
 * OpenAPI route tests (api-mcp/03).
 *
 * Verifies the spec endpoint returns a valid OpenAPI 3.1 document
 * with all expected paths and security schemes.
 */
import { describe, it, expect } from 'vitest';
import { createOpenApiRoute } from '../src/routes/openapi.route';

describe('OpenAPI route', () => {
  it('returns a valid OpenAPI 3.1 spec', async () => {
    const route = createOpenApiRoute({
      siteUrl: 'https://feasly.dev',
      version: '0.3.0',
    });

    const spec = (await route.handle()) as Record<string, unknown>;

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info).toMatchObject({
      title: 'Feasly Public API',
      version: '0.3.0',
    });
  });

  it('includes all public v1 paths', async () => {
    const route = createOpenApiRoute({
      siteUrl: 'https://feasly.dev',
      version: '0.3.0',
    });

    const spec = (await route.handle()) as {
      paths: Record<string, unknown>;
    };

    const paths = Object.keys(spec.paths);
    expect(paths).toContain('/v1/estimate');
    expect(paths).toContain('/v1/leads');
    expect(paths).toContain('/v1/embed/config');
    expect(paths).toContain('/v1/communities/{slug}/stats');
    expect(paths).toContain('/v1/events');
    expect(paths).toContain('/v1/admin/api-keys');
    expect(paths).toContain('/v1/admin/api-keys/{id}/rotate');
    expect(paths).toContain('/v1/admin/api-keys/{id}/revoke');
  });

  it('defines API key security schemes', async () => {
    const route = createOpenApiRoute({
      siteUrl: 'https://feasly.dev',
      version: '0.3.0',
    });

    const spec = (await route.handle()) as {
      components: {
        securitySchemes: Record<string, unknown>;
      };
    };

    expect(spec.components.securitySchemes).toHaveProperty('ApiKeyAuth');
    expect(spec.components.securitySchemes).toHaveProperty('AdminKey');
  });

  it('uses the configured site URL in servers', async () => {
    const route = createOpenApiRoute({
      siteUrl: 'https://example.com',
      version: '0.3.0',
    });

    const spec = (await route.handle()) as {
      servers: Array<{ url: string }>;
    };

    expect(spec.servers[0].url).toBe('https://example.com');
  });
});
