-- Per-(business, category) trust-ratchet autonomy state (Phase 6.1).
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-engine-design.md (§5)
-- and the roadmap "Phase 6.1" section.
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- A proven ai_proposed category auto-PROMOTES to owner_configured (stop confirming each
-- send; fire under the gate, surface only anomalies) once precision clears θ over a minimum
-- sample. A post-promotion opt-out spike auto-DEMOTES (safety backstop). The owner can veto a
-- promotion (vetoed=true → never auto-promote again). Default state is ai_proposed.
-- The unique (business_id, category) index keeps one autonomy row per category per business.

CREATE TABLE IF NOT EXISTS initiation_autonomy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL REFERENCES businesses(id),
  category text NOT NULL,
  state text NOT NULL DEFAULT 'ai_proposed',
  vetoed boolean NOT NULL DEFAULT false,
  promoted_at timestamp with time zone,
  demoted_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS initiation_autonomy_biz_category_idx
  ON initiation_autonomy USING btree (business_id, category);
