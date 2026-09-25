/**
 * Builder-config service (EMB-02).
 *
 * Resolution order: in-memory repo JSON first (`config/builders/*.json`,
 * inlined at build time by `tools/generate-builder-configs.ts`), DB
 * `tenants` row as the fallback. Unknown key → 404 UNKNOWN_TENANT.
 *
 * The injected configs are re-validated at creation (the build-time
 * generator already validated them — this is defense in depth and the
 * seam the unit tests exercise). DB rows are validated too: a corrupt
 * row fails loud instead of serving a broken embed.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { eq } from 'drizzle-orm';
import type { EmbedPublicConfig } from '@feasly/contracts';
import type { AppDb } from '../db/client';
import { tenants } from '../db/schema';
import { HttpError, ErrorCodes } from '../middleware/errors';
import {
  validateBuilderConfigs,
  type BuilderConfigFile,
} from './builder-config/builder-config.schema';

export interface BuilderConfigService {
  /** Resolve the public embed config for a tenant key. */
  getByKey(tenantKey: string): Promise<EmbedPublicConfig>;
}

export interface BuilderConfigServiceDeps {
  readonly db: AppDb;
  /** Inlined repo JSON: tenant_key → raw file contents. */
  readonly configs: Record<string, unknown>;
  /** True in development — permits http localhost origins. */
  readonly isDev: boolean;
  /** Defaults to console.warn; tests inject a spy. */
  readonly onWarning?: (message: string) => void;
}

/** The public wire shape — tenant_key stays internal. */
function toPublicConfig(file: BuilderConfigFile): EmbedPublicConfig {
  return {
    business_name: file.business_name,
    display_name: file.display_name,
    logo_url: file.logo_url,
    accent_color: file.accent_color,
    allowed_origins: [...file.allowed_origins],
    fallback_phone: file.fallback_phone,
    fallback_email: file.fallback_email,
    plan: file.plan,
  };
}

function toPublicConfigFromRow(row: typeof tenants.$inferSelect): EmbedPublicConfig {
  return {
    business_name: row.businessName,
    display_name: row.displayName,
    logo_url: row.logoUrl,
    accent_color: row.accentColor,
    allowed_origins: [...row.allowedOrigins],
    fallback_phone: row.fallbackPhone,
    fallback_email: row.fallbackEmail,
    plan: row.plan === 'flat' || row.plan === 'commission' ? row.plan : null,
  };
}

export function createBuilderConfigService(
  deps: BuilderConfigServiceDeps,
): BuilderConfigService {
  const { db, isDev, onWarning } = deps;
  // Startup validation: fail loud on a broken config, never serve one.
  const configs = validateBuilderConfigs(
    Object.entries(deps.configs).map(([file, data]) => ({
      file: `${file}.json`,
      data,
    })),
    { isDev, onWarning },
  );

  return {
    async getByKey(tenantKey: string): Promise<EmbedPublicConfig> {
      const fromFile = configs[tenantKey];
      if (fromFile !== undefined) return toPublicConfig(fromFile);

      const row = await db.query.tenants.findFirst({
        where: eq(tenants.tenantKey, tenantKey),
      });
      if (row !== undefined) return toPublicConfigFromRow(row);

      throw new HttpError(
        404,
        ErrorCodes.UNKNOWN_TENANT,
        `Unknown builder tenant: "${tenantKey}"`,
      );
    },
  };
}
