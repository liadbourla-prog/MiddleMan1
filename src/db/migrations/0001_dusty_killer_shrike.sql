CREATE TABLE "import_tokens" (
	"token" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"manager_phone" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"service_type_id" uuid NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"offered_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_by_role" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "slot_tz_at_creation" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "whatsapp_phone_number_id" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "whatsapp_access_token" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "min_booking_buffer_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "max_booking_days_ahead" integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "cancellation_cutoff_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "bot_persona" text DEFAULT 'neutral' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "onboarding_step" text DEFAULT 'business_name';--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "messaging_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_tokens" ADD CONSTRAINT "import_tokens_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_customer_id_identities_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_booking_trigger_idx" ON "reminders" USING btree ("booking_id","trigger_type");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_slot_customer_idx" ON "waitlist" USING btree ("business_id","slot_start","customer_id");--> statement-breakpoint
CREATE INDEX "waitlist_status_idx" ON "waitlist" USING btree ("business_id","status");