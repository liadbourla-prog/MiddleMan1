ALTER TABLE "businesses" ADD COLUMN "currency" text DEFAULT 'ILS' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "max_participants" integer DEFAULT 1 NOT NULL;