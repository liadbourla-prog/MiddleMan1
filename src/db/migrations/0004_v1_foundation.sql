-- Sprint 1: V1 Foundation migration
-- New columns on businesses
ALTER TABLE "businesses" ADD COLUMN "confirmation_gate" text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "available_247" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "calendar_mode" text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "escalation_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- New column on bookings
ALTER TABLE "bookings" ADD COLUMN "rebooking_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- New column on service_types (Google Calendar colorId)
ALTER TABLE "service_types" ADD COLUMN "color_id" integer;--> statement-breakpoint
-- provider_assignments: maps staff to service types
CREATE TABLE "provider_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"service_type_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_assignments_identity_service_idx" ON "provider_assignments" USING btree ("identity_id","service_type_id");--> statement-breakpoint
CREATE INDEX "provider_assignments_business_idx" ON "provider_assignments" USING btree ("business_id","is_active");--> statement-breakpoint
-- escalated_tasks: unknown/owner-rule escalations forwarded to operator
CREATE TABLE "escalated_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_phone" text NOT NULL,
	"message_body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"escalation_type" text NOT NULL,
	"trigger_rule" text,
	"forwarded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalated_tasks" ADD CONSTRAINT "escalated_tasks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "escalated_tasks_business_idx" ON "escalated_tasks" USING btree ("business_id","resolved_at");--> statement-breakpoint
-- agent_update_log: records operator-triggered bulk updates
CREATE TABLE "agent_update_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"update_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"applied_to_count" integer DEFAULT 0 NOT NULL
);
