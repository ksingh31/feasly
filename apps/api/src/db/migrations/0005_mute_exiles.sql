CREATE TABLE "community_stats" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avg_assessed_value" integer NOT NULL,
	"assessment_count" integer NOT NULL,
	"avg_lot_sqft" integer,
	"refreshed_at" timestamp with time zone NOT NULL
);
