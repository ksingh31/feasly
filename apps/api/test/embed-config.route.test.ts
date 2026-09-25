/**
 * Embed-config route tests (EMB-02).
 *
 * Covers: happy path (the story's wire shape), 404 UNKNOWN_TENANT from the
 * service, and 400 on a missing/invalid `key` query param.
 */
import { describe, expect, it } from 'vitest';
import type { EmbedPublicConfig } from '@feasly/contracts';
import {
  createEmbedConfigRoute,
} from '../src/routes/embed-config.route';
import type { BuilderConfigService } from '../src/services/builder-config.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const CONFIG: EmbedPublicConfig = {
  business_name: 'Elite Craft Builders',
  display_name: 'Elite Craft Builders',
  logo_url: '',
  accent_color: '#1a365d',
  allowed_origins: ['https://elitecraftbuilders.com'],
  fallback_phone: '',
  fallback_email: '',
  plan: null,
};

function serviceWith(
  configs: Record<string, EmbedPublicConfig>,
): BuilderConfigService {
  return {
    getByKey: async (key: string) => {
      const config = configs[key];
      if (!config) {
        throw new HttpError(404, ErrorCodes.UNKNOWN_TENANT, `Unknown: ${key}`);
      }
      return config;
    },
  };
}

describe('embed-config route', () => {
  it('returns the public config for ?key=', async () => {
    const route = createEmbedConfigRoute({
      builderConfig: serviceWith({ 'elite-craft-builders': CONFIG }),
    });
    await expect(
      route.handle({ key: 'elite-craft-builders' }),
    ).resolves.toEqual(CONFIG);
  });

  it('surfaces 404 UNKNOWN_TENANT for an unknown key', async () => {
    const route = createEmbedConfigRoute({
      builderConfig: serviceWith({}),
    });
    const error = await route.handle({ key: 'ghost' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).code).toBe(ErrorCodes.UNKNOWN_TENANT);
  });

  it.each([[{}], [{ key: '' }], [{ key: 42 }], [null], [undefined]])(
    'rejects invalid query %p with 400',
    async (query) => {
      const route = createEmbedConfigRoute({
        builderConfig: serviceWith({ 'elite-craft-builders': CONFIG }),
      });
      const error = await route.handle(query).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe(ErrorCodes.VALIDATION_FAILED);
    },
  );
});
