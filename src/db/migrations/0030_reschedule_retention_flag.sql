-- Reschedule-retention — per-business opt-in flag (Phase 3b).
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-roadmap.md (Phase 3b) and
-- the engine design §7.5. Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with
-- all migrations) by `npm run db:apply` (scripts/apply-all-migrations.ts); see
-- src/db/migrations/README.md.
--
-- Default OFF: when enabled, a genuine cancellation first offers available alternate slots;
-- accepting one converts the cancel into a reschedule (deferred-cancel). The owner flips
-- this later via the Phase-5 control surface; until then the cancellation flow is unchanged.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS reschedule_retention_enabled boolean NOT NULL DEFAULT false;
