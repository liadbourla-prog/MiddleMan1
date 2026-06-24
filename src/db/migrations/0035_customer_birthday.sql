-- Customer birthday — cheap nullable field on identities (Phase 2; engine design §7.6/§12).
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- Unlocks the birthday/holiday proactive initiator (catalog §8.3). Date only; null = unknown.
-- Captured later by the owner conversationally / via import — the initiator itself is follow-on.

ALTER TABLE identities ADD COLUMN IF NOT EXISTS birthday date;
