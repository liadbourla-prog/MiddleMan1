-- Owner-confirm gate for ai_proposed initiations (Phase 6a).
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-engine-design.md (§4.1/§5)
-- and the roadmap "Owner directive (2026-06-23)" section.
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- A sibling to freed_slot_approvals: a detector PROPOSES a customer-facing send (e.g.
-- win-back of a lapsed customer); the owner approves/declines before anything leaves.
-- The unique (business_id, dedup_key) index prevents re-nagging the owner about the
-- same proposal. situation/fallback are kept for LLM phrasing at SEND time (post-approval);
-- owner_summary is what the owner sees in the proposal.

CREATE TABLE IF NOT EXISTS initiation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL REFERENCES businesses(id),
  initiator_id text NOT NULL,
  recipient_id uuid REFERENCES identities(id),
  recipient_phone text NOT NULL,
  dedup_key text NOT NULL,
  language text NOT NULL,
  situation text NOT NULL,
  fallback text NOT NULL,
  owner_summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  decided_at timestamp with time zone,
  expires_at timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS initiation_approvals_dedup_idx
  ON initiation_approvals USING btree (business_id, dedup_key);

CREATE INDEX IF NOT EXISTS initiation_approvals_pending_idx
  ON initiation_approvals USING btree (business_id, status);
