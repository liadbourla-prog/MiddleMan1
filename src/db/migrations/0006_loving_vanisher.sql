CREATE TABLE "agent_update_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"update_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"applied_to_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_number" text,
	"email" text,
	"role" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_faqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deferred_feature_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"raw_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "manager_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_session_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"summary" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"service_type_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"step" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_step_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_name" text NOT NULL,
	"status" text NOT NULL,
	"input_snapshot" jsonb,
	"output_snapshot" jsonb,
	"latency_ms" integer,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error_context" jsonb,
	"tokens_used" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rebooking_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "whatsapp_app_secret" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "confirmation_gate" text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "available_247" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "calendar_mode" text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "default_language" text DEFAULT 'he' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "escalation_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "brand_voice" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "google_review_url" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "communication_style" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "notification_preferences" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "handoff_behavior" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "automated_messages_config" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "booking_edge_cases" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "cancellation_fee_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "cancellation_fee_currency" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "website_json" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "website_preview_url" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "daily_briefing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "daily_briefing_time" text DEFAULT '09:00';--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "preferred_language" text;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "color_id" integer;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "narrative" text;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "intake_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "intake_notes" text;--> statement-breakpoint
ALTER TABLE "business_contacts" ADD CONSTRAINT "business_contacts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_faqs" ADD CONSTRAINT "business_faqs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deferred_feature_requests" ADD CONSTRAINT "deferred_feature_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalated_tasks" ADD CONSTRAINT "escalated_tasks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_memory" ADD CONSTRAINT "manager_memory_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_memory" ADD CONSTRAINT "manager_memory_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_workflows" ADD CONSTRAINT "skill_workflows_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_workflows" ADD CONSTRAINT "skill_workflows_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_logs" ADD CONSTRAINT "workflow_step_logs_workflow_id_skill_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."skill_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_contacts_business_idx" ON "business_contacts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "escalated_tasks_business_idx" ON "escalated_tasks" USING btree ("business_id","resolved_at");--> statement-breakpoint
CREATE INDEX "manager_memory_identity_idx" ON "manager_memory" USING btree ("identity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_assignments_identity_service_idx" ON "provider_assignments" USING btree ("identity_id","service_type_id");--> statement-breakpoint
CREATE INDEX "provider_assignments_business_idx" ON "provider_assignments" USING btree ("business_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_skill_workflows_active" ON "skill_workflows" USING btree ("identity_id","skill_name") WHERE "skill_workflows"."status" = 'active';