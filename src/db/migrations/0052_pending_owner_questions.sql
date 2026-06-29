-- F3a/S3 — customer→owner question relay (ask-the-owner round-trip).
--
-- When a Branch-4 customer asks something the PA cannot answer from business facts/FAQs, the
-- PA now dispatches the question to the owner (Branch 3) instead of fabricating "I'll check
-- with the studio". This table records the pending question so the owner's later reply (via
-- the answerCustomerQuestion orchestrator tool, or a free-text fallback) can be relayed BACK
-- to the customer. Lifecycle: pending → answered (relayed) ; or → expired (owner-question
-- expiry worker, OWNER_QUESTION_EXPIRY_HOURS).
--
-- MIGRATION DISCIPLINE (§A2): runs AFTER 0051 (one migration committed before the next). New
-- table — no backfill. CREATE TABLE / CREATE INDEX IF NOT EXISTS are natively idempotent, so
-- apply-all-migrations.ts can re-run it safely.
CREATE TABLE IF NOT EXISTS "pending_owner_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL REFERENCES "businesses"("id"),
	"customer_id" uuid NOT NULL REFERENCES "identities"("id"),
	"customer_phone" text NOT NULL,
	"question_text" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"asked_manager_id" uuid REFERENCES "identities"("id"),
	"answer_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "pending_owner_questions_status_idx" ON "pending_owner_questions" ("business_id","status");
CREATE INDEX IF NOT EXISTS "pending_owner_questions_customer_idx" ON "pending_owner_questions" ("business_id","customer_id","status");
