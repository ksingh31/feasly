CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"route" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"consent_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "analytics_events_event_created_idx" ON "analytics_events" USING btree ("event","created_at");