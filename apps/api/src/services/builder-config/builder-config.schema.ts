/**
 * Builder-config file schema + validation (EMB-02).
 *
 * One canonical validator, two call sites:
 *  1. `tools/generate-builder-configs.ts` — build time. An invalid file
 *     fails the build, i.e. a deploy-time failure, never a silently broken
 *     embed.
 *  2. `createBuilderConfigService` — startup. Defense in depth; also the
 *     seam the unit tests exercise.
 *
 * Rules (per plan/stories/embed/02-builder-config.md):
 * - `accent_color` must be a valid #rrggbb hex.
 * - `allowed_origins` must be https origins; http localhost is allowed only
 *   when `isDev` (dev loop).
 * - `logo_url` may be '' (embed shell falls back to the Feasly wordmark).
 * - `plan` is inert until billing lands; null = undecided.
 * - Accent colors below 4.5:1 contrast against white LOG A WARNING (builder's
 *   choice, but visible) — never a failure.
 * - No builder PII beyond business contact info in these files.
 */
import { z } from 'zod';
import {
  contrastRatioAgainstWhite,
  MIN_ACCENT_CONTRAST,
} from '../../lib/contrast';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A single origin entry: scheme + host, no path/query/fragment. */
function validateOrigin(origin: string, isDev: boolean): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (
    isDev &&
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    return true;
  }
  return false;
}

/**
 * The zod schema for one `config/builders/{tenantKey}.json` file.
 * Unknown keys (e.g. `_comment`) are tolerated — Karan hand-edits these.
 */
export function createBuilderConfigFileSchema(isDev: boolean) {
  return z
    .object({
      tenant_key: z.string().min(1).max(100),
      business_name: z.string().min(1).max(200),
      display_name: z.string().min(1).max(200),
      logo_url: z.string().max(2000).refine(
        (value) => value === '' || /^https?:\/\//.test(value),
        { message: 'must be empty or an http(s) URL' },
      ),
      accent_color: z.string().regex(HEX_COLOR_RE, {
        message: 'must be a #rrggbb hex color',
      }),
      allowed_origins: z
        .array(z.string().max(500))
        .min(1, { message: 'at least one allowed origin is required' })
        .refine(
          (origins) => origins.every((o) => validateOrigin(o, isDev)),
          {
            message: isDev
              ? 'must be https origins (http localhost allowed in dev only)'
              : 'must be https origins',
          },
        ),
      fallback_phone: z.string().max(50),
      fallback_email: z
        .string()
        .max(320)
        .refine((value) => value === '' || z.string().email().safeParse(value).success, {
          message: 'must be empty or a valid email address',
        }),
      plan: z.enum(['flat', 'commission']).nullable(),
    })
    .passthrough();
}

export type BuilderConfigFile = z.infer<
  ReturnType<typeof createBuilderConfigFileSchema>
>;

export interface BuilderConfigSource {
  /** File name, used to name the culprit on validation failure. */
  readonly file: string;
  readonly data: unknown;
}

export interface ValidateBuilderConfigsOptions {
  readonly isDev: boolean;
  /** Defaults to console.warn; tests inject a spy. */
  readonly onWarning?: (message: string) => void;
}

/**
 * Validate every builder config file. Returns the configs keyed by
 * tenant_key. Throws a plain Error naming the file and field on the first
 * problem — fail loud, fail early.
 */
export function validateBuilderConfigs(
  sources: readonly BuilderConfigSource[],
  options: ValidateBuilderConfigsOptions,
): Record<string, BuilderConfigFile> {
  const { isDev, onWarning = console.warn } = options;
  const schema = createBuilderConfigFileSchema(isDev);
  const configs: Record<string, BuilderConfigFile> = {};
  for (const { file, data } of sources) {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const [first] = parsed.error.issues;
      const field = first.path.length > 0 ? `"${first.path.join('.')}"` : 'file';
      throw new Error(
        `invalid builder config "${file}": field ${field} — ${first.message}`,
      );
    }
    const config = parsed.data;
    if (configs[config.tenant_key] !== undefined) {
      throw new Error(
        `invalid builder config "${file}": duplicate tenant_key "${config.tenant_key}"`,
      );
    }
    const ratio = contrastRatioAgainstWhite(config.accent_color);
    if (ratio < MIN_ACCENT_CONTRAST) {
      onWarning(
        `builder config "${file}": accent_color ${config.accent_color} has ` +
          `contrast ${ratio.toFixed(2)}:1 against white, below the ` +
          `${MIN_ACCENT_CONTRAST}:1 AA threshold — the builder's choice, but text may be hard to read`,
      );
    }
    configs[config.tenant_key] = config;
  }
  return configs;
}
