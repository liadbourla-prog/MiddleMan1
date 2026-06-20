-- Integrity Sentinel findings (WS-B). See CALENDAR_BULLETPROOFING_PLAN.md.
--
-- Applied manually (this project's migrations are hand-applied, not via
-- drizzle-kit migrate). IF NOT EXISTS / guarded statements keep re-runs safe.

CREATE TABLE IF NOT EXISTS integrity_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  dedup_key text NOT NULL,
  booking_id uuid,
  slot_start timestamptz,
  detail jsonb,
  auto_remediated boolean NOT NULL DEFAULT false,
  quarantine_block_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  resolved_at timestamptz
);

-- At most one OPEN finding per (business, dedup_key): the dedup guarantee. Resolved
-- rows are exempt so history accumulates.
CREATE UNIQUE INDEX IF NOT EXISTS integrity_findings_open_dedup_idx
  ON integrity_findings (business_id, dedup_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS integrity_findings_business_status_idx
  ON integrity_findings (business_id, status);
