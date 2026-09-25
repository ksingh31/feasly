/**
 * GENERATED — do not edit by hand. Source: config/builders/*.json.
 * Regenerate: npm run build:configs --workspace @feasly/api
 * (also runs automatically via prebuild / pretest / prebundle:functions).
 */
import type { BuilderConfigFile } from '../services/builder-config/builder-config.schema';

export const BUILDER_CONFIGS: Record<string, BuilderConfigFile> =
  {
  "elite-craft-builders": {
    "tenant_key": "elite-craft-builders",
    "business_name": "Elite Craft Builders",
    "display_name": "Elite Craft Builders",
    "logo_url": "",
    "accent_color": "#B08D57",
    "allowed_origins": [
      "https://elitecraftbuilders.com"
    ],
    "fallback_phone": "",
    "fallback_email": "",
    "plan": null,
    "_comment": "Elite Craft Builders --- first real tenant (embed/05 dogfood). PLACEHOLDERS: logo_url (empty -> Feasly wordmark fallback), fallback_phone, fallback_email --- fill in when Elite provides brand assets. plan is inert until billing lands (embed/04); null = undecided."
  }
} as Record<string, BuilderConfigFile>;
