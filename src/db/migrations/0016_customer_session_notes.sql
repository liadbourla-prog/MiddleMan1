-- Customer cross-session conversation summaries (Branch 4 memory). A background
-- job writes a short private note when a customer conversation ends; the PA
-- re-reads the last few at the start of a future conversation so it can pick up
-- like a regular. Distinct from customer_profiles (booking-derived facts).
--
-- Applied manually (this project's migrations are hand-applied, not via
-- drizzle-kit migrate). IF NOT EXISTS keeps re-runs safe.

CREATE TABLE IF NOT EXISTS "customer_session_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "customer_session_notes" ADD CONSTRAINT "customer_session_notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "customer_session_notes" ADD CONSTRAINT "customer_session_notes_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "customer_session_notes_identity_idx" ON "customer_session_notes" USING btree ("identity_id","created_at");
