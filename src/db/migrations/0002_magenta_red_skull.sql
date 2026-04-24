CREATE TABLE "provider_onboarding_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manager_phone" text NOT NULL,
	"step" text DEFAULT 'business_name' NOT NULL,
	"collected_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_onboarding_sessions_manager_phone_unique" UNIQUE("manager_phone")
);
