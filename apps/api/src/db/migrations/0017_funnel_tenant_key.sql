ALTER TABLE "analytics_events" ADD COLUMN "tenant_key" text;--> statement-breakpoint
CREATE INDEX "analytics_events_tenant_created_idx" ON "analytics_events" USING btree ("tenant_key","created_at");