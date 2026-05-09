-- Multi-agent upgrade foundation: new tables, columns, and enum extension

-- Daily briefing opt-in columns on businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS daily_briefing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS daily_briefing_time text DEFAULT '09:00';

-- Cross-session manager conversation summaries
CREATE TABLE IF NOT EXISTS manager_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  identity_id uuid NOT NULL REFERENCES identities(id),
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  summary text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS manager_memory_identity_idx ON manager_memory (identity_id, created_at);

-- Non-customer business contacts (suppliers, partners, staff)
CREATE TABLE IF NOT EXISTS business_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  phone_number text,
  email text,
  role text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_contacts_business_idx ON business_contacts (business_id);

-- Cross-session operator notes for Branch 1 memory
CREATE TABLE IF NOT EXISTS operator_session_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary text NOT NULL,
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Extend manager_instructions.classified_as to include booking_cancellation
-- (text column — no enum migration needed, value is accepted by the DB as-is)
-- Rollback note: to revert the schema change, remove the new tables and columns:
--   DROP TABLE IF EXISTS operator_session_notes;
--   DROP TABLE IF EXISTS business_contacts;
--   DROP TABLE IF EXISTS manager_memory;
--   ALTER TABLE businesses DROP COLUMN IF EXISTS daily_briefing_enabled;
--   ALTER TABLE businesses DROP COLUMN IF EXISTS daily_briefing_time;
