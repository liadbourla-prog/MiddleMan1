-- Business knowledge configuration: communication style, notifications, automated messages, deferred requests

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS communication_style JSONB,
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB,
  ADD COLUMN IF NOT EXISTS handoff_behavior JSONB,
  ADD COLUMN IF NOT EXISTS automated_messages_config JSONB,
  ADD COLUMN IF NOT EXISTS booking_edge_cases JSONB,
  ADD COLUMN IF NOT EXISTS cancellation_fee_amount NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS cancellation_fee_currency TEXT;

ALTER TABLE service_types
  ADD COLUMN IF NOT EXISTS intake_notes TEXT;

CREATE TABLE IF NOT EXISTS deferred_feature_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  raw_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
