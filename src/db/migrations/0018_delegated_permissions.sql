-- Persisted staff edit permissions (PLAN Track 1C). One row per (identity, action)
-- the owner has granted a delegated_user — e.g. edit the calendar but not change
-- pricing. authorize() enforces these at the apply seam, closing the "in-memory
-- only" gap noted in src/domain/authorization/check.ts. `action` matches the
-- Action union there (plain text, no DB-level enum).
--
-- Applied manually (this project's migrations are hand-applied, not via
-- drizzle-kit migrate). IF NOT EXISTS / duplicate_object guards keep re-runs safe.

CREATE TABLE IF NOT EXISTS "delegated_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "delegated_permissions" ADD CONSTRAINT "delegated_permissions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "delegated_permissions" ADD CONSTRAINT "delegated_permissions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "delegated_permissions_identity_action_idx" ON "delegated_permissions" USING btree ("identity_id","action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_permissions_identity_idx" ON "delegated_permissions" USING btree ("identity_id");
