CREATE TABLE "tenants" (
	"tenant_key" text PRIMARY KEY NOT NULL,
	"business_name" text NOT NULL,
	"display_name" text NOT NULL,
	"logo_url" text DEFAULT '' NOT NULL,
	"accent_color" text NOT NULL,
	"allowed_origins" text[] NOT NULL,
	"fallback_phone" text DEFAULT '' NOT NULL,
	"fallback_email" text DEFAULT '' NOT NULL,
	"plan" text
);
