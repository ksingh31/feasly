/**
 * GENERATED — do not edit by hand. Source: config/builders/*.json.
 * Regenerate: npm run build:configs --workspace @feasly/api
 * (also runs automatically via prebuild / pretest / prebundle:functions).
 */
import type { BuilderConfigFile } from '../services/builder-config/builder-config.schema';

export const BUILDER_CONFIGS: Record<string, BuilderConfigFile> =
  {
  "demo": {
    "_comment": "Demo Builder --- QA/demo tenant for the embed flow (unblocks PR #94 browser QA on preview envs). PLACEHOLDERS: all branding is fictional (555-01xx phone range, example.com email, demo.example.com origin) --- swap for real tenant-key provisioning, which is a separate later story. plan is inert until billing lands; null = undecided.",
    "accent_color": "#0F766E",
    "allowed_origins": [
      "https://demo.example.com"
    ],
    "business_name": "Demo Builder",
    "display_name": "Demo Builder",
    "fallback_email": "demo@example.com",
    "fallback_phone": "(555) 010-2030",
    "logo_url": "",
    "plan": null,
    "tenant_key": "demo"
  },
  "elite-craft-builders": {
    "_comment": "Elite Craft Builders --- first real tenant (embed/05 dogfood). PLACEHOLDERS: logo_url (empty -> Feasly wordmark fallback), fallback_phone, fallback_email --- fill in when Elite provides brand assets. plan is inert until billing lands (embed/04); null = undecided.",
    "accent_color": "#B08D57",
    "allowed_origins": [
      "https://elitecraftbuilders.com"
    ],
    "business_name": "Elite Craft Builders",
    "display_name": "Elite Craft Builders",
    "fallback_email": "",
    "fallback_phone": "",
    "logo_url": "",
    "plan": null,
    "tenant_key": "elite-craft-builders"
  }
} as Record<string, BuilderConfigFile>;
