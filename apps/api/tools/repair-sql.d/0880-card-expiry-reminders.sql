-- #880: one-time card-expiry reminder dedupe (mirrors migration 0068_card_expiry_reminders).
CREATE TABLE IF NOT EXISTS "card_expiry_reminders" (
	"payment_method_id" text PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL,
	"exp_month" integer NOT NULL,
	"exp_year" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
