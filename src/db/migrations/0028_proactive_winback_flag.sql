-- Proactive win-back (churn) detector — per-business opt-in flag (Phase 4b).
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-roadmap.md (Phase 4b / 6a).
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- Default OFF: the win-back worker proposes lapsed-customer re-engagement to the owner
-- only for businesses that have explicitly opted in. The owner flips this later via the
-- Phase-5 control surface; until then the detector early-continues for every business.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS proactive_winback_enabled boolean NOT NULL DEFAULT false;
