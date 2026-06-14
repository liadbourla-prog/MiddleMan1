-- Recurring weekly class series (PLAN Track 1A). Recurrence lives ABOVE the
-- canonical availability spine: a class_series row is a master definition that a
-- materializer expands into concrete calendar_blocks instances (type='class',
-- series_id set). The booking engine and availability compute keep operating on
-- those instances unchanged. class_series_exceptions is the EXDATE list — the
-- materializer never (re)creates an instance for an excepted occurrence date.
--
-- The classified_as 'recurring_class_change' value lives on a plain text column
-- (no DB-level enum), so it needs no schema change here.
--
-- Applied manually (this project's migrations are hand-applied, not via
-- drizzle-kit migrate). IF NOT EXISTS / duplicate_object guards keep re-runs safe.

ALTER TABLE "calendar_blocks" ADD COLUMN IF NOT EXISTS "series_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_blocks_series_idx" ON "calendar_blocks" USING btree ("series_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "class_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"service_type_id" uuid NOT NULL,
	"provider_id" uuid,
	"day_of_week" integer NOT NULL,
	"start_time" time NOT NULL,
	"duration_minutes" integer NOT NULL,
	"max_participants" integer DEFAULT 1 NOT NULL,
	"title" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"timezone" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_series_day_of_week_range" CHECK ("class_series"."day_of_week" BETWEEN 0 AND 6)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "class_series_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "class_series" ADD CONSTRAINT "class_series_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "class_series" ADD CONSTRAINT "class_series_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "class_series" ADD CONSTRAINT "class_series_provider_id_identities_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "class_series_exceptions" ADD CONSTRAINT "class_series_exceptions_series_id_class_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."class_series"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "class_series_business_idx" ON "class_series" USING btree ("business_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "class_series_exceptions_series_date_idx" ON "class_series_exceptions" USING btree ("series_id","occurrence_date");
