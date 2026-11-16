-- One-time card-expiry reminder dedupe (#880).
--
-- Expand only: a new table, no change to existing rows. The primary key on
-- payment_method_id is what makes the reminder send at most once per card.
CREATE TABLE IF NOT EXISTS "card_expiry_reminders" (
	"payment_method_id" text PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL,
	"exp_month" integer NOT NULL,
	"exp_year" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
