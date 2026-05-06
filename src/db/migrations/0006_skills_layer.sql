-- Skills layer: brand knowledge, communication config, FAQs, workflow state, step audit log

-- ── businesses additions ──────────────────────────────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS brand_voice TEXT,
  ADD COLUMN IF NOT EXISTS google_review_url TEXT,
  ADD COLUMN IF NOT EXISTS communication_style JSONB,
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB,
  ADD COLUMN IF NOT EXISTS handoff_behavior JSONB,
  ADD COLUMN IF NOT EXISTS automated_messages_config JSONB,
  ADD COLUMN IF NOT EXISTS booking_edge_cases JSONB,
  ADD COLUMN IF NOT EXISTS cancellation_fee_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cancellation_fee_currency TEXT;

-- ── service_types additions ───────────────────────────────────────────────────
ALTER TABLE service_types
  ADD COLUMN IF NOT EXISTS narrative TEXT,
  ADD COLUMN IF NOT EXISTS intake_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS intake_notes TEXT;

-- ── business_faqs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── skill_workflows ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL REFERENCES identities(id),
  skill_name TEXT NOT NULL,
  step TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','failed')),
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforces one active workflow per identity per skill at the DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_workflows_active
  ON skill_workflows(identity_id, skill_name)
  WHERE status = 'active';

-- ── workflow_step_logs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_step_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES skill_workflows(id),
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','RETRYABLE','FATAL','PAUSED')),
  input_snapshot JSONB,
  output_snapshot JSONB,
  latency_ms INT,
  retry_count INT NOT NULL DEFAULT 0,
  error_context JSONB,
  tokens_used INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── deferred_feature_requests ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deferred_feature_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  raw_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
