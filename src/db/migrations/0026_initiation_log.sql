-- Proactive Initiations spine — the initiation ledger.
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-engine-design.md (Phase 1).
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- The unique (business_id, dedup_key) index IS the idempotency mechanism: dispatch
-- inserts with onConflictDoNothing; zero rows back = already sent. Skips are NOT written
-- here (they go to audit_log), so this stays a clean ledger of real sends and the
-- recipient index can back future per-recipient frequency caps cheaply.

CREATE TABLE IF NOT EXISTS initiation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL REFERENCES businesses(id),
  initiator_id text NOT NULL,
  recipient_id uuid REFERENCES identities(id),
  dedup_key text NOT NULL,
  decision text NOT NULL,
  audience text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS initiation_log_dedup_idx
  ON initiation_log USING btree (business_id, dedup_key);

CREATE INDEX IF NOT EXISTS initiation_log_recipient_idx
  ON initiation_log USING btree (recipient_id, created_at);
