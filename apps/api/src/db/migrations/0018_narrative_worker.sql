CREATE TABLE "narrative_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"estimate_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "narrative" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "narrative_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "narrative_generations" ADD CONSTRAINT "narrative_generations_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "narrative_generations_estimate_id_generated_at_idx" ON "narrative_generations" USING btree ("estimate_id","generated_at");