CREATE TABLE "ops_alert_state" (
	"type" text PRIMARY KEY NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_recovered_at" timestamp with time zone
);
