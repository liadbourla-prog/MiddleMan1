-- Meeting coordination (Branch 3). See docs/superpowers/specs/2026-06-21-meeting-coordination-design.md.
-- Hand-applied (IF NOT EXISTS / guarded) — re-runs are safe.

-- The identities.role column is a plain text column with a Drizzle-level enum (no
-- Postgres enum type), so the new 'contact' value needs no ALTER TYPE. If a CHECK
-- constraint on identities.role is ever added, widen it here.

CREATE TABLE IF NOT EXISTS meeting_coordinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  owner_id uuid NOT NULL REFERENCES identities(id),
  contact_id uuid NOT NULL REFERENCES identities(id),
  title text NOT NULL,
  duration_minutes integer NOT NULL,
  candidate_slots jsonb NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_counterparty'
    CHECK (status IN ('awaiting_counterparty','countered','awaiting_owner_confirm','confirmed','declined','expired','abandoned')),
  agreed_slot_start timestamptz,
  agreed_slot_end timestamptz,
  counter_slot_start timestamptz,
  counter_slot_end timestamptz,
  calendar_event_id text,
  google_etag text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_coordinations_contact_idx
  ON meeting_coordinations (business_id, contact_id, status);
CREATE INDEX IF NOT EXISTS meeting_coordinations_business_idx
  ON meeting_coordinations (business_id, status);
